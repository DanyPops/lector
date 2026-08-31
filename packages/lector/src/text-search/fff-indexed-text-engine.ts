import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileFinderApi, GrepCursor } from "@ff-labs/fff-bun";
import { IndexedSearchQueryBypass, type IndexedTextEngine, type IndexedTextEngineFactory, type IndexedTextStatus } from "./indexed-text-search.ts";
import type { TextSearchOptions, TextSearchWorkspaceOrigin } from "./port.ts";
import { boundMatchLine } from "./ripgrep-text-search.ts";
import { pathHasSkippedDirectorySegment } from "./skip-directories.ts";
import type { TextSearchMatch, TextSearchResult } from "./text-search-result.ts";

const MAX_MATCH_LINE_BYTES = 16 * 1024;
const IDENTITY_VERSION = 1;

interface CorpusIdentity {
	readonly digest: string;
	readonly files: number;
	readonly bytes: number;
}

interface PersistedIdentity extends CorpusIdentity {
	readonly version: typeof IDENTITY_VERSION;
	readonly indexedFiles?: number;
	readonly key: string;
	readonly origin: TextSearchWorkspaceOrigin;
	readonly recordedAt: number;
}

interface IdentityFile {
	readonly version: typeof IDENTITY_VERSION;
	readonly identities: readonly PersistedIdentity[];
}

export interface FffIndexedTextEngineOptions {
	readonly cacheRoot: string;
	readonly buildTimeoutMs: number;
	readonly searchTimeoutMs: number;
	readonly maxFiles: number;
	readonly maxSourceBytes: number;
	readonly maxSingleFileBytes: number;
	readonly maxPersistedIdentities: number;
	readonly maxPersistedIdentityBytes: number;
}

function isPersistedIdentity(value: unknown): value is PersistedIdentity {
	if (typeof value !== "object" || value === null) return false;
	const identity = value as Partial<PersistedIdentity>;
	return (
		identity.version === IDENTITY_VERSION &&
		typeof identity.key === "string" &&
		typeof identity.digest === "string" &&
		(identity.origin === "local" || identity.origin === "remote") &&
		typeof identity.files === "number" &&
		(identity.indexedFiles === undefined || typeof identity.indexedFiles === "number") &&
		typeof identity.bytes === "number" &&
		typeof identity.recordedAt === "number"
	);
}

class PersistedIdentityStore {
	private readonly identities = new Map<string, PersistedIdentity>();
	private readonly path: string;

	constructor(
		cacheRoot: string,
		private readonly maxEntries: number,
		private readonly maxBytes: number,
	) {
		if (maxEntries < 1 || maxBytes < 1) throw new TypeError("persisted identity bounds must be positive");
		mkdirSync(cacheRoot, { recursive: true });
		this.path = join(cacheRoot, "fff-identities.json");
		this.load();
	}

	get(key: string): PersistedIdentity | undefined {
		return this.identities.get(key);
	}

	record(identity: PersistedIdentity): void {
		const next = new Map(this.identities);
		next.set(identity.key, identity);
		while (next.size > this.maxEntries || this.serializedBytes(next) > this.maxBytes) {
			const candidates = [...next.values()]
				.filter((entry) => identity.origin === "local" || entry.origin === "remote")
				.sort((left, right) => (left.origin === right.origin ? left.recordedAt - right.recordedAt : left.origin === "remote" ? -1 : 1));
			const evicted = candidates[0];
			if (!evicted) return;
			next.delete(evicted.key);
		}
		this.identities.clear();
		for (const [key, value] of next) this.identities.set(key, value);
		this.persist();
	}

	private serialized(map: ReadonlyMap<string, PersistedIdentity>): string {
		return JSON.stringify({ version: IDENTITY_VERSION, identities: [...map.values()] } satisfies IdentityFile);
	}

	private serializedBytes(map: ReadonlyMap<string, PersistedIdentity>): number {
		return Buffer.byteLength(this.serialized(map), "utf8");
	}

	private load(): void {
		try {
			if (statSync(this.path).size > this.maxBytes) return;
			const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || (parsed as Partial<IdentityFile>).version !== IDENTITY_VERSION) return;
			const identities = (parsed as Partial<IdentityFile>).identities;
			if (!Array.isArray(identities) || identities.length > this.maxEntries) return;
			for (const identity of identities) if (isPersistedIdentity(identity)) this.identities.set(identity.key, identity);
		} catch {
			// A missing or malformed cache is disposable; the resident index rebuilds from source.
		}
	}

	private persist(): void {
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, this.serialized(this.identities));
		renameSync(temporary, this.path);
	}
}

function workspaceKey(rootPath: string): string {
	return createHash("sha256").update(rootPath).digest("hex");
}

function sameIdentity(left: CorpusIdentity, right: CorpusIdentity): boolean {
	return left.digest === right.digest && left.files === right.files && left.bytes === right.bytes;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new Error("indexed build aborted");
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error("indexed build aborted");
	return await new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("indexed build aborted"));
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

class FffIndexedTextEngine implements IndexedTextEngine {
	private finder?: FileFinderApi;
	private origin: TextSearchWorkspaceOrigin = "local";
	private activeIdentity?: CorpusIdentity;
	private readonly key: string;

	constructor(
		private readonly rootPath: string,
		private readonly options: FffIndexedTextEngineOptions,
		private readonly identities: PersistedIdentityStore,
	) {
		this.key = workspaceKey(rootPath);
	}

	setOrigin(origin: TextSearchWorkspaceOrigin): void {
		this.origin = origin;
	}

	async status(): Promise<IndexedTextStatus> {
		const persisted = this.identities.get(this.key);
		if (!this.finder || !this.activeIdentity) {
			return {
				state: "missing",
				...(persisted?.indexedFiles === undefined ? {} : { indexedFiles: persisted.indexedFiles }),
				...(persisted ? { persistedIdentity: persisted.digest } : {}),
			};
		}
		const health = this.finder.healthCheck();
		return {
			state: "fresh",
			...(health.ok && health.value.filePicker.indexedFiles !== undefined ? { indexedFiles: health.value.filePicker.indexedFiles } : {}),
			persistedIdentity: this.activeIdentity.digest,
		};
	}

	async build(signal: AbortSignal): Promise<void> {
		const before = await this.inventory(signal);
		const { FileFinder } = await import("@ff-labs/fff-bun");
		const created = FileFinder.create({
			basePath: this.rootPath,
			aiMode: true,
			followSymlinks: false,
			cacheBudgetMaxFiles: this.options.maxFiles,
			cacheBudgetMaxBytes: this.options.maxSourceBytes,
			cacheBudgetMaxFileSize: this.options.maxSingleFileBytes,
		});
		if (!created.ok) throw new Error(`FFF index creation failed: ${created.error}`);
		const candidate = created.value;
		try {
			const ready = await abortable(candidate.waitForIndexReady(this.options.buildTimeoutMs), signal);
			if (!ready.ok || !ready.value) throw new Error(`FFF index build exceeded ${this.options.buildTimeoutMs}ms`);
			const after = await this.inventory(signal);
			if (!sameIdentity(before, after)) throw new Error("workspace changed during indexed build");
			const previous = this.finder;
			this.finder = candidate;
			this.activeIdentity = after;
			const health = candidate.healthCheck();
			const indexedFiles = health.ok ? health.value.filePicker.indexedFiles : undefined;
			this.identities.record({
				...after,
				version: IDENTITY_VERSION,
				key: this.key,
				origin: this.origin,
				recordedAt: Date.now(),
				...(indexedFiles === undefined ? {} : { indexedFiles }),
			});
			previous?.destroy();
		} catch (error) {
			candidate.destroy();
			throw error;
		}
	}

	async search(query: string, options: TextSearchOptions): Promise<TextSearchResult> {
		const finder = this.finder;
		if (!finder) throw new Error("FFF index is not ready");
		if (options.signal?.aborted) throw new Error("indexed search aborted");
		const maxMatchLineBytes = Math.max(1, Math.min(MAX_MATCH_LINE_BYTES, options.maxMatches > 1 ? Math.floor(options.maxBytes / 2) : options.maxBytes));
		const maxCandidates = Math.min(Number.MAX_SAFE_INTEGER, options.maxMatches * 4);
		const matches: TextSearchMatch[] = [];
		let bytesUsed = 0;
		let candidatesSeen = 0;
		let cursor: GrepCursor | null = null;
		let truncated = false;
		do {
			const pageSize = Math.max(1, maxCandidates - candidatesSeen);
			const result = finder.grep(query, {
				mode: "regex",
				smartCase: false,
				maxFileSize: this.options.maxSingleFileBytes,
				maxMatchesPerFile: maxCandidates,
				pageSize,
				cursor,
				timeBudgetMs: this.options.searchTimeoutMs,
			});
			if (!result.ok) throw new Error(`FFF indexed search failed: ${result.error}`);
			if (result.value.regexFallbackError) throw new IndexedSearchQueryBypass(query);
			for (const item of result.value.items) {
				candidatesSeen += 1;
				if (pathHasSkippedDirectorySegment(item.relativePath)) continue;
				const [matchStart, matchEnd] = item.matchRanges[0] ?? [0, 0];
				const bounded = boundMatchLine(item.lineContent, matchStart, matchEnd, maxMatchLineBytes);
				if (bytesUsed + bounded.bytes > options.maxBytes || matches.length >= options.maxMatches) {
					truncated = true;
					continue;
				}
				matches.push({
					path: item.relativePath,
					lineNumber: item.lineNumber,
					line: bounded.line,
					...(bounded.lineTruncated ? { lineTruncated: true as const, lineStartByte: bounded.lineStartByte } : {}),
					matchStart: bounded.matchStart,
					matchEnd: bounded.matchEnd,
				});
				bytesUsed += bounded.bytes;
			}
			cursor = result.value.nextCursor;
		} while (cursor && candidatesSeen < maxCandidates && matches.length < options.maxMatches && bytesUsed < options.maxBytes);
		if (cursor) truncated = true;
		if (options.signal?.aborted) throw new Error("indexed search aborted");
		return { matches, truncated };
	}

	close(): void {
		this.finder?.destroy();
		this.finder = undefined;
		this.activeIdentity = undefined;
	}

	private async inventory(signal: AbortSignal): Promise<CorpusIdentity> {
		throwIfAborted(signal);
		const paths: string[] = [];
		let scannedEntries = 0;
		const maxScannedEntries = this.options.maxFiles * 8;
		const visit = async (relativeDirectory: string): Promise<void> => {
			const directory = await opendir(join(this.rootPath, relativeDirectory));
			for await (const entry of directory) {
				throwIfAborted(signal);
				scannedEntries += 1;
				if (scannedEntries > maxScannedEntries) throw new Error(`indexed corpus scan exceeds ${maxScannedEntries} entries`);
				if (entry.name === ".git" || entry.name === ".xgrep" || entry.name === "node_modules") continue;
				const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
				if (entry.isDirectory()) await visit(relativePath);
				else if (entry.isFile()) {
					paths.push(relativePath);
					if (paths.length > this.options.maxFiles) throw new Error(`indexed corpus exceeds ${this.options.maxFiles} files`);
				}
			}
		};
		await visit("");
		const digest = createHash("sha256");
		let bytes = 0;
		for (const path of paths.sort()) {
			throwIfAborted(signal);
			const absolutePath = join(this.rootPath, path);
			const size = (await stat(absolutePath)).size;
			if (size > this.options.maxSingleFileBytes) throw new Error(`indexed file exceeds ${this.options.maxSingleFileBytes} bytes: ${path}`);
			bytes += size;
			if (bytes > this.options.maxSourceBytes) throw new Error(`indexed corpus exceeds ${this.options.maxSourceBytes} bytes`);
			digest
				.update(path)
				.update("\0")
				.update(await readFile(absolutePath))
				.update("\0");
		}
		return { digest: digest.digest("hex"), files: paths.length, bytes };
	}
}

export class FffIndexedTextEngineFactory implements IndexedTextEngineFactory {
	private readonly identities: PersistedIdentityStore;

	constructor(private readonly options: FffIndexedTextEngineOptions) {
		const bounds = [
			options.buildTimeoutMs,
			options.searchTimeoutMs,
			options.maxFiles,
			options.maxSourceBytes,
			options.maxSingleFileBytes,
			options.maxPersistedIdentities,
			options.maxPersistedIdentityBytes,
		];
		if (!bounds.every((value) => Number.isSafeInteger(value) && value > 0)) throw new TypeError("FFF indexed-search bounds must be positive safe integers");
		this.identities = new PersistedIdentityStore(options.cacheRoot, options.maxPersistedIdentities, options.maxPersistedIdentityBytes);
	}

	open(rootPath: string): IndexedTextEngine {
		return new FffIndexedTextEngine(rootPath, this.options, this.identities);
	}
}
