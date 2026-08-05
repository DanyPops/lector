import type { ContentHash } from "../content-identity/content-hash.ts";
import type { SymbolGraphPopulationFailure } from "./populate-symbol-graph.ts";

/**
 * The next generation's per-file hash map: a skipped file carries its previous hash forward
 * unchanged; a reprocessed file gets its fresh hash only if it actually succeeded. When
 * `failuresTruncated` is true, the recorded failures don't cover every failure, so which
 * reprocessed files really succeeded can't be known -- fails closed by recording none of them,
 * forcing a full retry of the whole reprocessed batch next time rather than risking a wrongly
 * skipped file that never actually succeeded.
 */
export function computeUpdatedFileContentHashes(
	previousHashes: Readonly<Record<string, ContentHash>> | undefined,
	skippedFiles: readonly string[],
	reprocessedFiles: readonly string[],
	currentHashes: ReadonlyMap<string, ContentHash>,
	failures: readonly SymbolGraphPopulationFailure[],
	failuresTruncated: boolean,
): Record<string, ContentHash> {
	const updated: Record<string, ContentHash> = {};
	for (const file of skippedFiles) {
		const hash = previousHashes?.[file];
		if (hash !== undefined) updated[file] = hash;
	}
	if (!failuresTruncated) {
		const failedPaths = new Set(failures.map((failure) => failure.path));
		for (const file of reprocessedFiles) {
			if (failedPaths.has(file)) continue;
			const hash = currentHashes.get(file);
			if (hash !== undefined) updated[file] = hash;
		}
	}
	return updated;
}
