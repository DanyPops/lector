import type { ContentHash } from "../content-identity/content-hash.ts";

export interface FileReprocessSelection {
	/** Files whose content actually changed (or is new/never successfully processed). */
	readonly changed: readonly string[];
	/** Files whose content is unchanged and eligible to skip re-walking entirely. */
	readonly unchanged: readonly string[];
}

/**
 * Diffs the current file set against the previous generation's per-file content hashes. A file
 * absent from `previousHashes` (new, or failed last time -- only successes are ever recorded
 * there) always counts as changed, so a previously-failed file keeps retrying every population.
 */
export function diffFileHashes(
	files: readonly string[],
	currentHashes: ReadonlyMap<string, ContentHash>,
	previousHashes: Readonly<Record<string, ContentHash>> | undefined,
): FileReprocessSelection {
	if (!previousHashes) return { changed: [...files], unchanged: [] };
	const changed: string[] = [];
	const unchanged: string[] = [];
	for (const file of files) {
		const current = currentHashes.get(file);
		const previous = previousHashes[file];
		if (current !== undefined && previous !== undefined && current === previous) unchanged.push(file);
		else changed.push(file);
	}
	return { changed, unchanged };
}
