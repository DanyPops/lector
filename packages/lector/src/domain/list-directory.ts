import type { FileTreeEntry, FileTreePort } from "../ports/file-tree-port.ts";

export interface DirectoryListing {
	readonly path: string;
	readonly entries: readonly FileTreeEntry[];
}

/** Oil's own default sort: directories first, then everything else, alphabetical within each group. */
function directorySortRank(kind: FileTreeEntry["kind"]): number {
	return kind === "directory" ? 0 : 1;
}

function compareEntries(a: FileTreeEntry, b: FileTreeEntry): number {
	const rankDifference = directorySortRank(a.kind) - directorySortRank(b.kind);
	return rankDifference !== 0 ? rankDifference : a.name.localeCompare(b.name);
}

/** Lists `path`'s immediate children, sorted directories-first-then-alphabetical -- display policy, not something every FileTreePort adapter must reproduce itself. */
export async function listDirectory(fileTree: FileTreePort, path: string): Promise<DirectoryListing> {
	const entries = await fileTree.listDirectory(path);
	return { path, entries: [...entries].sort(compareEntries) };
}
