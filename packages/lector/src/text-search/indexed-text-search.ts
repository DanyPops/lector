import type { FindFilesResult } from "./find-files-result.ts";
import type { FindFilesOptions, TextSearchOptions, TextSearchPort, TextSearchWorkspaceOrigin } from "./port.ts";
import type { LexicalSearchProvenance, TextSearchResult } from "./text-search-result.ts";

export class IndexedSearchQueryBypass extends Error {
	constructor(readonly query: string) {
		super("query requires ripgrep regex compatibility");
		this.name = "IndexedSearchQueryBypass";
	}
}

export interface IndexedTextStatus {
	readonly state: "fresh" | "stale" | "missing";
	readonly indexedFiles?: number;
	readonly indexSizeBytes?: number;
	readonly persistedIdentity?: string;
}

export interface IndexedTextEngine {
	status(): Promise<IndexedTextStatus>;
	build(signal: AbortSignal): Promise<void>;
	search(query: string, options: TextSearchOptions): Promise<TextSearchResult>;
	setOrigin?(origin: TextSearchWorkspaceOrigin): void;
	close?(): void;
}

export interface IndexedTextEngineFactory {
	open(rootPath: string): IndexedTextEngine;
}

export interface IndexedTextSearchOptions {
	readonly maxConcurrentBuilds: number;
	readonly maxQueuedBuilds: number;
	readonly maxTrackedWorkspaces: number;
}

type RuntimeState = "unknown" | "loading" | "stale" | "ready" | "degraded";

interface TrackedIndex {
	readonly rootPath: string;
	readonly engine: IndexedTextEngine;
	origin: TextSearchWorkspaceOrigin;
	state: RuntimeState;
	queued: boolean;
	buildController?: AbortController;
	lastUsed: number;
	persistedStatus?: IndexedTextStatus;
}

function fallbackProvenance(state: RuntimeState | "unavailable" | "bypassed"): LexicalSearchProvenance {
	return {
		kind: "lexical",
		backend: "ripgrep",
		indexState: state === "unknown" ? "loading" : state === "ready" ? "degraded" : state,
	};
}

/**
 * Serves fresh ripgrep results while a bounded resident index builds, then switches to FFF.
 * Local workspaces always outrank disposable remote workspaces in tracking and build admission.
 */
export class IndexedTextSearch implements TextSearchPort {
	private readonly tracked = new Map<string, TrackedIndex>();
	private readonly localQueue: string[] = [];
	private readonly remoteQueue: string[] = [];
	private activeBuilds = 0;
	private closed = false;
	private clock = 0;

	constructor(
		private readonly fallback: TextSearchPort,
		private readonly factory: IndexedTextEngineFactory,
		private readonly options: IndexedTextSearchOptions,
	) {
		if (![options.maxConcurrentBuilds, options.maxQueuedBuilds, options.maxTrackedWorkspaces].every((value) => Number.isSafeInteger(value) && value > 0)) {
			throw new TypeError("indexed-search bounds must be positive");
		}
	}

	registerWorkspace(rootPath: string, origin: TextSearchWorkspaceOrigin): void {
		const existing = this.tracked.get(rootPath);
		if (existing) {
			if (origin === "local") {
				existing.origin = "local";
				existing.engine.setOrigin?.("local");
			}
			existing.lastUsed = ++this.clock;
			return;
		}
		if (this.tracked.size >= this.options.maxTrackedWorkspaces) {
			if (origin === "remote") return;
			const disposable = [...this.tracked.values()].filter((entry) => entry.origin === "remote").sort((left, right) => left.lastUsed - right.lastUsed)[0];
			if (!disposable) return;
			this.remove(disposable.rootPath);
		}
		const engine = this.factory.open(rootPath);
		engine.setOrigin?.(origin);
		this.tracked.set(rootPath, {
			rootPath,
			engine,
			origin,
			state: "unknown",
			queued: false,
			lastUsed: ++this.clock,
		});
	}

	invalidate(rootPath: string): void {
		const entry = this.tracked.get(rootPath);
		if (!entry) return;
		entry.state = "stale";
		this.enqueue(entry);
	}

	releaseWorkspace(rootPath: string): void {
		this.remove(rootPath);
	}

	status(rootPath: string): { readonly state: RuntimeState | "unavailable"; readonly origin?: TextSearchWorkspaceOrigin } {
		const entry = this.tracked.get(rootPath);
		return entry ? { state: entry.state, origin: entry.origin } : { state: "unavailable" };
	}

	async search(rootPath: string, query: string, options: TextSearchOptions): Promise<TextSearchResult> {
		let entry = this.tracked.get(rootPath);
		if (!entry) {
			this.registerWorkspace(rootPath, "local");
			entry = this.tracked.get(rootPath);
		}
		if (!entry) return this.withFallbackProvenance(await this.fallback.search(rootPath, query, options), "unavailable");
		entry.lastUsed = ++this.clock;
		if (entry.state === "unknown") {
			const persisted = await entry.engine.status();
			entry.persistedStatus = persisted;
			if (persisted.state === "fresh") entry.state = "ready";
			else {
				entry.state = persisted.state === "stale" ? "stale" : "loading";
				this.enqueue(entry);
			}
		}
		if (entry.state !== "ready") {
			return this.withFallbackProvenance(await this.fallback.search(rootPath, query, options), entry.state);
		}
		try {
			const result = await entry.engine.search(query, options);
			const persisted = entry.persistedStatus ?? { state: "fresh" as const };
			return {
				...result,
				provenance: {
					kind: "lexical",
					backend: "fff",
					indexState: "ready",
					...(persisted.indexedFiles === undefined ? {} : { indexedFiles: persisted.indexedFiles }),
					...(persisted.indexSizeBytes === undefined ? {} : { indexSizeBytes: persisted.indexSizeBytes }),
				},
			};
		} catch (error) {
			if (error instanceof IndexedSearchQueryBypass) {
				return this.withFallbackProvenance(await this.fallback.search(rootPath, query, options), "bypassed");
			}
			entry.state = "degraded";
			return this.withFallbackProvenance(await this.fallback.search(rootPath, query, options), "degraded");
		}
	}

	async findFiles(rootPath: string, patterns: readonly string[], options: FindFilesOptions): Promise<FindFilesResult> {
		return this.fallback.findFiles(rootPath, patterns, options);
	}

	close(): void {
		this.closed = true;
		for (const entry of this.tracked.values()) {
			entry.buildController?.abort();
			entry.engine.close?.();
		}
		this.tracked.clear();
		this.localQueue.length = 0;
		this.remoteQueue.length = 0;
	}

	private withFallbackProvenance(result: TextSearchResult, state: RuntimeState | "unavailable" | "bypassed"): TextSearchResult {
		return { ...result, provenance: fallbackProvenance(state) };
	}

	private enqueue(entry: TrackedIndex): void {
		if (this.closed || entry.queued || entry.buildController) return;
		const queuedCount = this.localQueue.length + this.remoteQueue.length;
		if (queuedCount >= this.options.maxQueuedBuilds) {
			if (entry.origin === "remote") {
				entry.state = "degraded";
				return;
			}
			const displacedRoot = this.remoteQueue.shift();
			if (!displacedRoot) {
				entry.state = "degraded";
				return;
			}
			const displaced = this.tracked.get(displacedRoot);
			if (displaced) {
				displaced.queued = false;
				displaced.state = "degraded";
			}
		}
		entry.queued = true;
		(entry.origin === "local" ? this.localQueue : this.remoteQueue).push(entry.rootPath);
		this.pump();
	}

	private pump(): void {
		while (!this.closed && this.activeBuilds < this.options.maxConcurrentBuilds) {
			const rootPath = this.localQueue.shift() ?? this.remoteQueue.shift();
			if (!rootPath) return;
			const entry = this.tracked.get(rootPath);
			if (!entry?.queued) continue;
			entry.queued = false;
			const controller = new AbortController();
			entry.buildController = controller;
			this.activeBuilds += 1;
			void entry.engine
				.build(controller.signal)
				.then(async () => {
					if (this.tracked.get(rootPath) !== entry || controller.signal.aborted) return;
					const persisted = await entry.engine.status();
					entry.persistedStatus = persisted;
					entry.state = persisted.state === "fresh" ? "ready" : "degraded";
				})
				.catch(() => {
					if (this.tracked.get(rootPath) === entry && !controller.signal.aborted) entry.state = "degraded";
				})
				.finally(() => {
					if (entry.buildController === controller) entry.buildController = undefined;
					this.activeBuilds -= 1;
					this.pump();
				});
		}
	}

	private remove(rootPath: string): void {
		const entry = this.tracked.get(rootPath);
		entry?.buildController?.abort();
		entry?.engine.close?.();
		this.tracked.delete(rootPath);
		for (const queue of [this.localQueue, this.remoteQueue]) {
			const index = queue.indexOf(rootPath);
			if (index >= 0) queue.splice(index, 1);
		}
	}
}
