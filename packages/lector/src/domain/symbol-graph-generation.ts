import type { IntelligenceProvenance } from "./intelligence-provenance.ts";
import type { PopulateSymbolGraphResult } from "./populate-symbol-graph.ts";
import type { RepoReference } from "./repo-reference.ts";

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

export type WorkspaceCacheStatus =
	| { readonly status: "not-cached"; readonly reason: "no-completed-generation" | "bounds-changed" | "source-changed" }
	| { readonly status: "caching"; readonly jobId: string }
	| { readonly status: "partial"; readonly generation: SymbolGraphGeneration }
	| { readonly status: "cached"; readonly generation: SymbolGraphGeneration };
