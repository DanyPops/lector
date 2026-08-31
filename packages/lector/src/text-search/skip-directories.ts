/**
 * Directory names that are never source, never a scan target, and never
 * worth ranking -- shared by every adapter that walks or classifies a
 * workspace's own file tree (source scanning, text search, symbol-graph
 * ranking), so there is one policy, not several independently-maintained
 * copies that can drift.
 */
export const SKIP_DIRECTORY_NAMES = new Set(["node_modules", ".git", ".xgrep", "dist", "build", "out", "coverage"]);

/** True when any segment of `path` (absolute or relative, either separator) is one of SKIP_DIRECTORY_NAMES -- e.g. a symbol graph node whose declaration lives under node_modules, reached only via an edge from the user's own code, never a direct scan target itself. */
export function pathHasSkippedDirectorySegment(path: string): boolean {
	return path.split(/[/\\]/).some((segment) => SKIP_DIRECTORY_NAMES.has(segment));
}
