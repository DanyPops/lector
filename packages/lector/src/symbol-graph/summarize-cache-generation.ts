import type { SymbolGraphPopulationFailure } from "./populate-symbol-graph.ts";
import type { CacheFailureSummaryEntry, CacheGenerationSummary, SymbolGraphGeneration } from "./symbol-graph-generation.ts";

/**
 * Bounds on the wire-level failure summary specifically -- independent of MAX_RECORDED_FAILURES
 * (populate-symbol-graph.ts's own cap on how many raw failures one generation retains at all).
 * A generation can legitimately retain up to 100 raw failures; a status check should still never
 * have to carry all 100 of them, deduplicated or not, just to answer "is this workspace cached".
 */
const MAX_FAILURE_SUMMARY_ENTRIES = 20;
const MAX_FAILURE_SUMMARY_MESSAGE_LENGTH = 160;

/**
 * Collapses repeated (path, operation, code) triples into one counted entry -- a defensive
 * dedup, not primarily aimed at "many different files hit the same error" (those remain
 * distinct entries; the path is part of the key), but at never letting a literal duplicate
 * record double-count in a summary a caller might reasonably total up.
 */
export function summarizeCacheFailures(failures: readonly SymbolGraphPopulationFailure[]): {
	readonly failureSummary: readonly CacheFailureSummaryEntry[];
	readonly failureSummaryTruncated: boolean;
} {
	const byKey = new Map<string, { path: string; operation: string; code: string; message: string; count: number }>();
	for (const failure of failures) {
		const key = `${failure.path}\u0000${failure.operation}\u0000${failure.code}`;
		const existing = byKey.get(key);
		if (existing) {
			existing.count++;
			continue;
		}
		byKey.set(key, {
			path: failure.path,
			operation: failure.operation,
			code: failure.code,
			message: failure.message.slice(0, MAX_FAILURE_SUMMARY_MESSAGE_LENGTH),
			count: 1,
		});
	}
	const entries = [...byKey.values()];
	return {
		failureSummary: Object.freeze(entries.slice(0, MAX_FAILURE_SUMMARY_ENTRIES)),
		failureSummaryTruncated: entries.length > MAX_FAILURE_SUMMARY_ENTRIES,
	};
}

/**
 * The compact view of one generation that crosses the wire by default -- strips walkedFiles and
 * fileContentHashes entirely (delta-population-only bookkeeping a status caller never needs) and
 * replaces the raw, bounded-to-100 failures list with a deduplicated, further-bounded summary.
 * Live evidence: a 500-file workspace's own cacheStatus response inlined 500 walked paths, a
 * 208-entry content-hash map, and up to 100 raw failure messages -- none of it answering the one
 * question a caller actually asked ("is this cached, and how bad is what failed"). The full raw
 * detail remains reachable through workspace.cacheWalkedFiles/workspace.cacheFailures for a
 * caller that genuinely needs it, paginated and separately bounded.
 */
export function summarizeCacheGeneration(generation: SymbolGraphGeneration): CacheGenerationSummary {
	const { failureSummary, failureSummaryTruncated } = summarizeCacheFailures(generation.result.failures);
	return {
		sourceFingerprint: generation.sourceFingerprint,
		completedAt: generation.completedAt,
		maxFiles: generation.maxFiles,
		maxSymbolsPerFile: generation.maxSymbolsPerFile,
		walkedFileCount: generation.walkedFiles?.length ?? 0,
		...(generation.provenance ? { provenance: generation.provenance } : {}),
		...(generation.sources ? { sources: generation.sources } : {}),
		result: {
			completeness: generation.result.completeness,
			filesAttempted: generation.result.filesAttempted,
			filesProcessed: generation.result.filesProcessed,
			filesFailed: generation.result.filesFailed,
			symbolsProcessed: generation.result.symbolsProcessed,
			nodesAdded: generation.result.nodesAdded,
			edgesAdded: generation.result.edgesAdded,
			...(generation.result.filesReused !== undefined ? { filesReused: generation.result.filesReused } : {}),
			...(generation.result.filesReprocessed !== undefined ? { filesReprocessed: generation.result.filesReprocessed } : {}),
			...(generation.result.staleRetries !== undefined ? { staleRetries: generation.result.staleRetries } : {}),
			...(generation.result.sourceCoverage ? { sourceCoverage: generation.result.sourceCoverage } : {}),
			...(generation.result.sourceGeneration ? { sourceGeneration: generation.result.sourceGeneration } : {}),
			failureCount: generation.result.failureCount,
			failureSummary,
			failureSummaryTruncated: failureSummaryTruncated || generation.result.failuresTruncated,
		},
	};
}
