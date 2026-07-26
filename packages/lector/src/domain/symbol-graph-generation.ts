import type { IntelligenceProvenance } from "./intelligence-provenance.ts";
import type { PopulateSymbolGraphResult } from "./populate-symbol-graph.ts";

export interface SymbolGraphGeneration {
	readonly sourceFingerprint: string;
	readonly maxFiles: number;
	readonly maxSymbolsPerFile: number;
	readonly completedAt: number;
	/** Absent only for generations persisted before provenance was recorded. */
	readonly provenance?: IntelligenceProvenance;
	readonly result: PopulateSymbolGraphResult;
}

export type WorkspaceCacheStatus =
	| { readonly status: "not-cached"; readonly reason: "no-completed-generation" | "bounds-changed" | "source-changed" }
	| { readonly status: "caching"; readonly jobId: string }
	| { readonly status: "cached"; readonly generation: SymbolGraphGeneration };
