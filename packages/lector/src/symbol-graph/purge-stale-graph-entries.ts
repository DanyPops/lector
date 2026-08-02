import type { SymbolGraphPort } from "./port.ts";

/**
 * Removes graph nodes/edges for files that were walked in a previous generation but are absent
 * from the current one -- a deleted file's declarations must not survive it forever. Never
 * touches a path that was never directly walked (e.g. a callee node resolved into a dependency
 * or system header outside the workspace's own source set): only a path this workspace itself
 * populated on a prior run is eligible for purging, so an external symbol referenced by a real
 * edge is never mistaken for a deleted one.
 */
export async function purgeFilesNoLongerWalked(
	graph: SymbolGraphPort,
	previousWalkedFiles: readonly string[] | undefined,
	currentFiles: readonly string[],
): Promise<readonly string[]> {
	if (!previousWalkedFiles || previousWalkedFiles.length === 0) return [];
	const currentSet = new Set(currentFiles);
	const stale = previousWalkedFiles.filter((path) => !currentSet.has(path));
	for (const path of stale) await graph.removeNodesForFile(path);
	return stale;
}
