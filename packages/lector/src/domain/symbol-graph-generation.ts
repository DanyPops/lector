import type { IntelligenceProvenance } from "./intelligence-provenance.ts";
import type { PopulateSymbolGraphResult } from "./populate-symbol-graph.ts";

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
	 * still clean, at the documented cost that a change to an already-gitignored source-extension
	 * file is invisible to this check (git has no record of an ignored file's content at all,
	 * under any flag) -- see "Lector: findSourceFiles should respect .gitignore" for the fix.
	 */
	readonly gitHeadSha?: string;
	/** Absent only for generations persisted before provenance was recorded. */
	readonly provenance?: IntelligenceProvenance;
	/** Per-language authorities included when provenance is polyglot. */
	readonly sources?: readonly IntelligenceProvenance[];
	readonly result: PopulateSymbolGraphResult;
}

export type WorkspaceCacheStatus =
	| { readonly status: "not-cached"; readonly reason: "no-completed-generation" | "bounds-changed" | "source-changed" }
	| { readonly status: "caching"; readonly jobId: string }
	| { readonly status: "partial"; readonly generation: SymbolGraphGeneration }
	| { readonly status: "cached"; readonly generation: SymbolGraphGeneration };
