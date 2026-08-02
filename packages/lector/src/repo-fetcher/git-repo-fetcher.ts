import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LRUCache } from "lru-cache";
import simpleGit from "simple-git";
import { measureDirectorySizeBytes } from "../adapters/directory-size.ts";
import { assertSafeRepoReference } from "../domain/assert-safe-repo-reference.ts";
import type { RepoCacheListEntry } from "./cached-repository-entry.ts";
import type { RepoFetcherPort } from "./port.ts";
import { RepoFetchCapacityExceeded, RepoFetchFailed, RepoFetchLimitExceeded, type RepoFetchPolicy, type RepoFetchResult } from "./repo-fetch-result.ts";
import type { RepoReference } from "./repo-reference.ts";

interface RepoCacheEntry {
	readonly path: string;
	readonly resolvedRef: string;
	readonly commit: string;
	readonly cloneSizeBytes: number;
	readonly cacheSizeBytes: number;
	readonly fetchedAt: number;
}

const INDEX_FILENAME = "index.json";
const DEFAULT_MAX_CACHE_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_QUEUED = 32;
const COMMIT_HASH = /^[0-9a-f]{40,64}$/i;

function cacheKey(reference: RepoReference): string {
	return `${reference.host}/${reference.owner}/${reference.repo}/${reference.ref ?? "HEAD"}`;
}

/**
 * Reverses cacheKey exactly -- host/owner/repo never contain "/" (git hosting naming rules), so
 * the first two slashes unambiguously delimit them; everything after the third slash is the
 * requested ref verbatim, including one that itself contains slashes (e.g. a branch named
 * "feature/foo").
 */
function parseCacheKey(key: string): { host: string; owner: string; repo: string; requestedRef: string } {
	const [host, owner, repo, ...refParts] = key.split("/");
	return { host: host ?? "", owner: owner ?? "", repo: repo ?? "", requestedRef: refParts.join("/") };
}

export interface GitRepoFetcherOptions {
	/** Disk budget in bytes across every cached clone. Least-recently-fetched clones are deleted once exceeded. */
	readonly maxCacheBytes?: number;
	readonly maxEntries?: number;
	readonly maxQueued?: number;
	/** Maps a reference to what git should clone from. Defaults to `https://<host>/<owner>/<repo>.git`. Overridable so tests can point at a real local bare-repo fixture instead of the network. */
	readonly resolveCloneUrl?: (reference: RepoReference) => string;
}

function defaultCloneUrl(reference: RepoReference): string {
	return `https://${reference.host}/${reference.owner}/${reference.repo}.git`;
}

function positiveLimit(value: number | undefined, fallback: number, field: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${field} must be a positive safe integer`);
	return result;
}

function nonNegativeLimit(value: number | undefined, fallback: number, field: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function validDump(value: unknown): value is Parameters<LRUCache<string, RepoCacheEntry>["load"]>[0] {
	if (!Array.isArray(value)) return false;
	return value.every((item) => {
		if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !isRecord(item[1])) return false;
		const entry = item[1].value;
		return (
			isRecord(entry) &&
			typeof entry.path === "string" &&
			typeof entry.resolvedRef === "string" &&
			typeof entry.commit === "string" &&
			COMMIT_HASH.test(entry.commit) &&
			typeof entry.cloneSizeBytes === "number" &&
			typeof entry.cacheSizeBytes === "number" &&
			typeof entry.fetchedAt === "number"
		);
	});
}

/**
 * RepoFetcherPort backed by a real bounded `git` checkout. Calls are serialized because this
 * daemon is the sole writer of reposDir. Exact callers never fall back to HEAD.
 */
export class GitRepoFetcher implements RepoFetcherPort {
	private readonly reposDir: string;
	private readonly indexPath: string;
	private readonly resolveCloneUrl: (reference: RepoReference) => string;
	private readonly maxCacheBytes: number;
	private readonly maxQueued: number;
	private readonly cache: LRUCache<string, RepoCacheEntry>;
	private pending = 0;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(reposDir: string, options: GitRepoFetcherOptions = {}) {
		this.reposDir = reposDir;
		this.indexPath = join(reposDir, INDEX_FILENAME);
		this.resolveCloneUrl = options.resolveCloneUrl ?? defaultCloneUrl;
		this.maxCacheBytes = positiveLimit(options.maxCacheBytes, DEFAULT_MAX_CACHE_BYTES, "maxCacheBytes");
		this.maxQueued = nonNegativeLimit(options.maxQueued, DEFAULT_MAX_QUEUED, "maxQueued");
		this.cache = new LRUCache<string, RepoCacheEntry>({
			maxSize: this.maxCacheBytes,
			maxEntrySize: Number.MAX_SAFE_INTEGER,
			max: positiveLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries"),
			dispose: (entry) => {
				rmSync(entry.path, { recursive: true, force: true });
			},
		});
		this.loadIndex();
	}

	async fetch(reference: RepoReference, policy: RepoFetchPolicy = {}): Promise<RepoFetchResult> {
		assertSafeRepoReference(reference);
		if (this.pending > this.maxQueued) throw new RepoFetchCapacityExceeded(this.maxQueued);
		const normalizedPolicy = {
			exactRef: policy.exactRef ?? false,
			maxCloneBytes: positiveLimit(policy.maxCloneBytes, Number.MAX_SAFE_INTEGER, "maxCloneBytes"),
			maxCacheBytes: positiveLimit(policy.maxCacheBytes, this.maxCacheBytes, "maxCacheBytes"),
			timeoutMs: positiveLimit(policy.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs"),
			forceRefresh: policy.forceRefresh ?? false,
		};
		this.pending++;
		const deadline = Date.now() + normalizedPolicy.timeoutMs;
		const task = this.queue.then(() => {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new RepoFetchFailed(reference.host, reference.owner, reference.repo, reference.ref, new Error("fetch timed out in queue"));
			return this.fetchLocked(reference, { ...normalizedPolicy, timeoutMs: remaining });
		});
		this.queue = task.then(
			() => undefined,
			() => undefined,
		);
		return task.finally(() => {
			this.pending--;
		});
	}

	private trimToCacheBound(maxCacheBytes: number, requiredBytes = 0): void {
		while (this.cache.calculatedSize + requiredBytes > maxCacheBytes && this.cache.size > 0) this.cache.pop();
	}

	private cachedResult(key: string, reference: RepoReference, policy: Required<RepoFetchPolicy>): RepoFetchResult | null {
		const cached = this.cache.get(key);
		if (!cached) return null;
		if (policy.exactRef && reference.ref !== null && cached.resolvedRef !== reference.ref) {
			this.cache.delete(key);
			return null;
		}
		if (cached.cloneSizeBytes > policy.maxCloneBytes) {
			throw new RepoFetchLimitExceeded("clone-bytes", policy.maxCloneBytes, cached.cloneSizeBytes);
		}
		if (cached.cacheSizeBytes > policy.maxCacheBytes) {
			throw new RepoFetchLimitExceeded("cache-bytes", policy.maxCacheBytes, cached.cacheSizeBytes);
		}
		this.trimToCacheBound(policy.maxCacheBytes);
		if (!this.cache.has(key)) throw new RepoFetchLimitExceeded("cache-bytes", policy.maxCacheBytes, cached.cacheSizeBytes);
		return {
			path: cached.path,
			fromCache: true,
			resolvedRef: cached.resolvedRef,
			refFallbackOccurred: false,
			commit: cached.commit,
		};
	}

	private async fetchLocked(reference: RepoReference, policy: Required<RepoFetchPolicy>): Promise<RepoFetchResult> {
		const key = cacheKey(reference);
		const cached = policy.forceRefresh ? null : this.cachedResult(key, reference, policy);
		if (cached) return cached;
		// A forced refresh reclones into the SAME deterministic targetDir a stale cache entry for
		// this key already points at. Evict that stale entry (and let its own dispose remove the
		// old directory) up front, before cloning -- otherwise the later cache.set() below would
		// overwrite the same key and fire dispose against the entry being replaced, whose path is
		// identical to the fresh one just renamed into place, deleting the directory this call is
		// meant to leave behind. Confirmed live: a forced refresh previously returned a result
		// pointing at a directory that no longer existed on disk.
		if (policy.forceRefresh) this.cache.delete(key);

		const targetDir = join(this.reposDir, reference.host, reference.owner, reference.repo, reference.ref ?? "HEAD");
		await rm(targetDir, { recursive: true, force: true });
		const tmpDir = `${targetDir}.tmp-${process.pid}-${Date.now()}`;
		await rm(tmpDir, { recursive: true, force: true });

		const url = this.resolveCloneUrl(reference);
		let resolvedRef = reference.ref ?? "HEAD";
		let refFallbackOccurred = false;
		try {
			if (policy.exactRef && reference.ref !== null) {
				await this.cloneExact(url, reference.ref, tmpDir, policy.timeoutMs);
			} else {
				await this.clone(url, reference.ref, tmpDir, policy.timeoutMs);
			}
		} catch (firstError) {
			if (reference.ref === null || policy.exactRef) {
				await rm(tmpDir, { recursive: true, force: true });
				throw new RepoFetchFailed(reference.host, reference.owner, reference.repo, reference.ref, firstError);
			}
			await rm(tmpDir, { recursive: true, force: true });
			try {
				await this.clone(url, null, tmpDir, policy.timeoutMs);
				refFallbackOccurred = true;
				resolvedRef = "HEAD";
			} catch (secondError) {
				await rm(tmpDir, { recursive: true, force: true });
				throw new RepoFetchFailed(reference.host, reference.owner, reference.repo, reference.ref, secondError);
			}
		}

		try {
			const git = simpleGit({ baseDir: tmpDir, timeout: { block: policy.timeoutMs } });
			const commit = (await git.revparse(["HEAD"])).trim();
			if (!COMMIT_HASH.test(commit)) throw new Error("git returned an invalid commit id");
			const cloneSizeBytes = await measureDirectorySizeBytes(tmpDir);
			if (cloneSizeBytes > policy.maxCloneBytes) throw new RepoFetchLimitExceeded("clone-bytes", policy.maxCloneBytes, cloneSizeBytes);
			await rm(join(tmpDir, ".git"), { recursive: true, force: true });
			const cacheSizeBytes = await measureDirectorySizeBytes(tmpDir);
			if (cacheSizeBytes > policy.maxCacheBytes) throw new RepoFetchLimitExceeded("cache-bytes", policy.maxCacheBytes, cacheSizeBytes);
			this.trimToCacheBound(policy.maxCacheBytes, cacheSizeBytes);
			await mkdir(dirname(targetDir), { recursive: true });
			await rename(tmpDir, targetDir);

			const entry: RepoCacheEntry = { path: targetDir, resolvedRef, commit, cloneSizeBytes, cacheSizeBytes, fetchedAt: Date.now() };
			this.cache.set(key, entry, { size: cacheSizeBytes });
			this.persistIndex();
			return { path: targetDir, fromCache: false, resolvedRef, refFallbackOccurred, commit };
		} catch (error) {
			await rm(tmpDir, { recursive: true, force: true });
			throw error;
		}
	}

	/**
	 * `git ls-remote` against the reference's own tracked ref, never against a local checkout --
	 * this must work even when nothing has been cloned yet. Any failure (unreachable remote,
	 * timeout, a ref that isn't a moving branch/tag such as an exact commit sha, which ls-remote
	 * simply won't list) returns undefined rather than throwing: the caller treats undefined as
	 * "couldn't tell," never as evidence of staleness.
	 */
	/** Serialized through the same queue as fetch(), so an eviction can never race a concurrent clone into the same key's directory. */
	async evict(reference: RepoReference): Promise<boolean> {
		assertSafeRepoReference(reference);
		const task = this.queue.then(() => this.evictLocked(reference));
		this.queue = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	private evictLocked(reference: RepoReference): boolean {
		const key = cacheKey(reference);
		if (!this.cache.has(key)) return false;
		this.cache.delete(key); // fires dispose -> rmSync of the checkout directory
		this.persistIndex();
		return true;
	}

	async resolveRemoteCommit(reference: RepoReference, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | undefined> {
		try {
			assertSafeRepoReference(reference);
		} catch {
			return undefined;
		}
		const url = this.resolveCloneUrl(reference);
		const refSpec = reference.ref ?? "HEAD";
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const git = simpleGit({ timeout: { block: timeoutMs }, abort: controller.signal });
			const output = await git.listRemote([url, refSpec]);
			const sha = output.trim().split("\n")[0]?.split(/\s+/)[0];
			return sha !== undefined && COMMIT_HASH.test(sha) ? sha : undefined;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}

	async listCached(): Promise<readonly RepoCacheListEntry[]> {
		// LRUCache's own entries() iterator never updates recency or otherwise mutates the cache --
		// only get()/has() (with non-default options) do that.
		return Array.from(this.cache.entries(), ([key, value]) => {
			const { host, owner, repo, requestedRef } = parseCacheKey(key);
			return {
				host,
				owner,
				repo,
				requestedRef,
				resolvedRef: value.resolvedRef,
				commit: value.commit,
				path: value.path,
				cacheSizeBytes: value.cacheSizeBytes,
				fetchedAt: value.fetchedAt,
			};
		});
	}

	private async clone(url: string, ref: string | null, targetDir: string, timeoutMs: number): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const options = ref ? ["--quiet", "--depth", "1", "--branch", ref] : ["--quiet", "--depth", "1"];
			await simpleGit({ timeout: { block: timeoutMs }, abort: controller.signal }).clone(url, targetDir, options);
		} finally {
			clearTimeout(timer);
		}
	}

	private async cloneExact(url: string, ref: string, targetDir: string, timeoutMs: number): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			await mkdir(targetDir, { recursive: true });
			const git = simpleGit({ baseDir: targetDir, timeout: { block: timeoutMs }, abort: controller.signal });
			await git.init(["--quiet"]);
			await git.addRemote("origin", url);
			await git.raw(["fetch", "--quiet", "--depth", "1", "origin", ref]);
			await git.raw(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
		} finally {
			clearTimeout(timer);
		}
	}

	private loadIndex(): void {
		if (!existsSync(this.indexPath)) return;
		try {
			const dumped: unknown = JSON.parse(readFileSync(this.indexPath, "utf8"));
			if (validDump(dumped)) this.cache.load(dumped);
		} catch {
			// An invalid index is disposable; fetched repositories can be cloned again.
		}
	}

	private persistIndex(): void {
		mkdirSync(this.reposDir, { recursive: true });
		const temp = `${this.indexPath}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(this.cache.dump()), "utf8");
		renameSync(temp, this.indexPath);
	}
}
