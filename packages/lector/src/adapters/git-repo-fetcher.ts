import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LRUCache } from "lru-cache";
import simpleGit from "simple-git";
import { assertSafeRepoReference } from "../domain/assert-safe-repo-reference.ts";
import { RepoFetchFailed, type RepoFetchResult } from "../domain/repo-fetch-result.ts";
import type { RepoReference } from "../domain/repo-reference.ts";
import type { RepoFetcherPort } from "../ports/repo-fetcher-port.ts";
import { measureDirectorySizeBytes } from "./directory-size.ts";

interface RepoCacheEntry {
	readonly path: string;
	readonly resolvedRef: string;
	readonly fetchedAt: number;
}

const INDEX_FILENAME = "index.json";
const DEFAULT_MAX_CACHE_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 500;

function cacheKey(reference: RepoReference): string {
	return `${reference.host}/${reference.owner}/${reference.repo}/${reference.ref ?? "HEAD"}`;
}

export interface GitRepoFetcherOptions {
	/** Disk budget in bytes across every cached clone. Least-recently-fetched clones are deleted once exceeded. */
	readonly maxCacheBytes?: number;
	readonly maxEntries?: number;
	/** Maps a reference to what git should clone from. Defaults to `https://<host>/<owner>/<repo>.git`. Overridable so tests can point at a real local bare-repo fixture instead of the network. */
	readonly resolveCloneUrl?: (reference: RepoReference) => string;
}

function defaultCloneUrl(reference: RepoReference): string {
	return `https://${reference.host}/${reference.owner}/${reference.repo}.git`;
}

/**
 * RepoFetcherPort backed by a real `git clone --depth 1`, content-addressed by
 * (host, owner, repo, ref) under `reposDir`. Disk usage is bounded by an LRU cache keyed the same
 * way; evicting an entry deletes its directory, so the cache and the filesystem never disagree
 * about what's actually on disk. Calls are serialized through an in-process queue -- this daemon
 * is the sole writer of reposDir, so a promise chain is sufficient; no cross-process file lock
 * is needed.
 */
export class GitRepoFetcher implements RepoFetcherPort {
	private readonly reposDir: string;
	private readonly indexPath: string;
	private readonly resolveCloneUrl: (reference: RepoReference) => string;
	private readonly cache: LRUCache<string, RepoCacheEntry>;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(reposDir: string, options: GitRepoFetcherOptions = {}) {
		this.reposDir = reposDir;
		this.indexPath = join(reposDir, INDEX_FILENAME);
		this.resolveCloneUrl = options.resolveCloneUrl ?? defaultCloneUrl;
		this.cache = new LRUCache<string, RepoCacheEntry>({
			maxSize: options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES,
			// A single clone larger than the whole budget must still be stored (evicting everything
			// else) rather than silently rejected -- lru-cache's own default couples this to maxSize.
			maxEntrySize: Number.MAX_SAFE_INTEGER,
			max: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
			dispose: (entry) => {
				rmSync(entry.path, { recursive: true, force: true });
			},
		});
		this.loadIndex();
	}

	async fetch(reference: RepoReference): Promise<RepoFetchResult> {
		assertSafeRepoReference(reference);
		const task = this.queue.then(() => this.fetchLocked(reference));
		this.queue = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	private async fetchLocked(reference: RepoReference): Promise<RepoFetchResult> {
		const key = cacheKey(reference);
		const cached = this.cache.get(key);
		if (cached) {
			return { path: cached.path, fromCache: true, resolvedRef: cached.resolvedRef, refFallbackOccurred: false };
		}

		const targetDir = join(this.reposDir, reference.host, reference.owner, reference.repo, reference.ref ?? "HEAD");
		await rm(targetDir, { recursive: true, force: true });
		const tmpDir = `${targetDir}.tmp-${process.pid}-${Date.now()}`;
		await rm(tmpDir, { recursive: true, force: true });

		const url = this.resolveCloneUrl(reference);
		let resolvedRef = reference.ref ?? "HEAD";
		let refFallbackOccurred = false;
		try {
			await this.clone(url, reference.ref, tmpDir);
		} catch (firstError) {
			if (reference.ref === null) {
				throw new RepoFetchFailed(reference.host, reference.owner, reference.repo, reference.ref, firstError);
			}
			await rm(tmpDir, { recursive: true, force: true });
			try {
				await this.clone(url, null, tmpDir);
				refFallbackOccurred = true;
				resolvedRef = "HEAD";
			} catch (secondError) {
				throw new RepoFetchFailed(reference.host, reference.owner, reference.repo, reference.ref, secondError);
			}
		}

		await rm(join(tmpDir, ".git"), { recursive: true, force: true });
		await mkdir(dirname(targetDir), { recursive: true });
		await rename(tmpDir, targetDir);

		const sizeBytes = await measureDirectorySizeBytes(targetDir);
		const entry: RepoCacheEntry = { path: targetDir, resolvedRef, fetchedAt: Date.now() };
		this.cache.set(key, entry, { size: sizeBytes });
		this.persistIndex();

		return { path: targetDir, fromCache: false, resolvedRef, refFallbackOccurred };
	}

	private async clone(url: string, ref: string | null, targetDir: string): Promise<void> {
		const options = ref ? ["--depth", "1", "--branch", ref] : ["--depth", "1"];
		await simpleGit().clone(url, targetDir, options);
	}

	private loadIndex(): void {
		if (!existsSync(this.indexPath)) return;
		try {
			const dumped = JSON.parse(readFileSync(this.indexPath, "utf8")) as Parameters<typeof this.cache.load>[0];
			this.cache.load(dumped);
		} catch {
			// Corrupt or unreadable index -- start fresh, do not throw. Directories left over from a
			// prior run are cleaned up lazily the next time their key is fetched again (fetchLocked
			// always rm's targetDir before cloning into it).
		}
	}

	private persistIndex(): void {
		mkdirSync(this.reposDir, { recursive: true });
		const temp = `${this.indexPath}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(this.cache.dump()), "utf8");
		renameSync(temp, this.indexPath);
	}
}
