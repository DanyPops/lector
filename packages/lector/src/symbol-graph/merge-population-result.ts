import type { PopulateSymbolGraphResult } from "./populate-symbol-graph.ts";

/**
 * Rescopes a delta pass's own result (covering only the reprocessed subset) to the whole
 * workspace: a skipped file is still correctly represented in the graph from a prior
 * generation, so it counts as processed here too, just not re-walked this round.
 */
export function mergePopulationResult(reprocessResult: PopulateSymbolGraphResult, skippedFileCount: number, totalFileCount: number): PopulateSymbolGraphResult {
	return {
		...reprocessResult,
		filesAttempted: totalFileCount,
		filesProcessed: reprocessResult.filesProcessed + skippedFileCount,
	};
}
