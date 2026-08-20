import type { IntelligenceProvenance } from "../code-intelligence/intelligence-provenance.ts";
import type { ContentHash } from "../content-identity/content-hash.ts";
import type { RepoReference } from "../repo-fetcher/repo-reference.ts";
import type { PopulateSymbolGraphResult, PopulationProgress } from "./populate-symbol-graph.ts";

export interface SymbolGraphGeneration {
	readonly sourceFingerprint: string;
	readonly maxFiles: number;
	readonly maxSymbolsPerFile: number;
	readonly completedAt: number;
	/**
	 * The git HEAD commit this generation was captured at, present only when the workspace is a
	 * git repository AND its working tree was clean at population time -- a dirty tree's content
	 * isn't represented by any single sha, so recording one would be meaningless. Lets a later
	 * cache-freshness check skip a full source rehash when HEAD is unchanged and the tree is
	 * still clean. Gitignored files are never part of the source manifest this sha stands in for
	 * (findSourceFiles excludes them), so a change to one can't make this check answer wrong.
	 */
	readonly gitHeadSha?: string;
	/** Absent only for generations persisted before provenance was recorded. */
	readonly provenance?: IntelligenceProvenance;
	/** Per-language authorities included when provenance is polyglot. */
	readonly sources?: readonly IntelligenceProvenance[];
	readonly result: PopulateSymbolGraphResult;
	/**
	 * The exact absolute paths walked to produce this generation, bounded by maxFiles. The next
	 * regeneration diffs its own walked set against this one to find files that disappeared, so a
	 * deleted file's stale nodes/edges are purged instead of surviving forever. Absent only for
	 * generations persisted before purge-on-regeneration existed.
	 */
	readonly walkedFiles?: readonly string[];
	/**
	 * Content hash of every successfully-processed file in walkedFiles, bounded the same way.
	 * A file absent here (never processed, or processed but failed) is always reprocessed on the
	 * next population -- absence, not a stale/wrong hash, is what forces a retry. Lets the next
	 * population skip re-walking a file whose hash is unchanged. Absent entirely for generations
	 * persisted before delta population existed, which forces a full reprocess of everything.
	 */
	readonly fileContentHashes?: Readonly<Record<string, ContentHash>>;
	/**
	 * The remote reference this generation was populated against, present only for a workspace
	 * fetched via repo.fetch. Absent for a local workspace, or a remote one persisted before this
	 * field existed -- either way, no baseline means the remote-freshness check can't run, not
	 * that the workspace is treated as stale.
	 */
	readonly remoteReference?: RepoReference;
	/**
	 * The remote's commit for remoteReference's tracked ref at population time, resolved via
	 * RepoFetcherPort.resolveRemoteCommit (a live ls-remote, not the clone's own commit) --
	 * lets a later cacheStatus check tell whether the origin has moved without re-cloning.
	 */
	readonly remoteCommit?: string;
}

/** One (path, operation, code) group from summarizeCacheFailures -- message is one representative example, truncated shorter than a raw SymbolGraphPopulationFailure's own message; count is always 1 today (one failure per group per generation) but stays honest if that ever changes. */
export interface CacheFailureSummaryEntry {
	readonly path: string;
	readonly operation: string;
	readonly code: string;
	readonly message: string;
	readonly count: number;
}

/** The counts every cache-status caller actually asks for -- both a raw PopulateSymbolGraphResult and this compact summary satisfy it structurally, so pi-lector's own rendering can accept either without knowing which one it got. */
export interface CacheResultCounts {
	readonly filesAttempted: number;
	readonly filesProcessed: number;
	readonly filesFailed: number;
	readonly symbolsProcessed: number;
	readonly nodesAdded: number;
	readonly edgesAdded: number;
}

/** The compact view of one generation's own population result that crosses the wire by default -- see summarize-cache-generation.ts for why. */
export interface CacheGenerationResultSummary extends CacheResultCounts {
	readonly completeness: "complete" | "partial";
	readonly failureCount: number;
	readonly failureSummary: readonly CacheFailureSummaryEntry[];
	readonly failureSummaryTruncated: boolean;
}

/**
 * The compact view of one SymbolGraphGeneration that crosses the wire by default -- omits
 * walkedFiles and fileContentHashes entirely (delta-population-only bookkeeping, never useful to
 * a status caller) and reports only a count of how many files were walked. The full raw detail
 * remains reachable through workspace.cacheWalkedFiles/workspace.cacheFailures.
 */
export interface CacheGenerationSummary {
	readonly completedAt: number;
	readonly maxFiles: number;
	readonly maxSymbolsPerFile: number;
	readonly walkedFileCount: number;
	readonly result: CacheGenerationResultSummary;
	/** Absent only for generations persisted before provenance was recorded -- carried through unabridged, unlike walkedFiles/fileContentHashes/failures: a fixed-size object, not one that grows with file count. */
	readonly provenance?: IntelligenceProvenance;
	/** Per-language authorities included when provenance is polyglot -- see provenance's own note on why this rides along unabridged. */
	readonly sources?: readonly IntelligenceProvenance[];
}

export type WorkspaceCacheStatus =
	| { readonly status: "not-cached"; readonly reason: "no-completed-generation" | "bounds-changed" | "source-changed" }
	/** progress is undefined until the first file of this run completes -- nothing walked yet is a real, distinct state from "no progress data available at all". */
	| { readonly status: "caching"; readonly jobId: string; readonly progress?: PopulationProgress }
	/** The job is running but its own populateSymbolGraph call is queued waiting for a warm-index slot reserved for foreground work, not actually walking files -- distinct from "caching" so a caller can tell "genuinely working" from "waiting its turn behind interactive queries". */
	| { readonly status: "waiting-for-resources"; readonly jobId: string; readonly progress?: PopulationProgress }
	| { readonly status: "partial"; readonly generation: CacheGenerationSummary }
	| { readonly status: "cached"; readonly generation: CacheGenerationSummary };
