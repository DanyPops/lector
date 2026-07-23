import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * The nearest enclosing git repository root starting from (and including)
 * a given directory, or undefined if none is found (e.g. /tmp scratch
 * files, dotfiles outside any repo). Callers choose their own fallback --
 * see lector-client.ts's workspaceForPath (falls back to the filesystem
 * root: any absolute path is fair game for read/write/edit, exactly as
 * Pi's built-in tools already allow) vs. workspaceForDirectory (falls back
 * to the directory itself: widening a symbol-search scope all the way to
 * the entire filesystem when a project isn't a git repo would be absurd).
 *
 * This -- not a Pi session's original cwd -- is Lector's real workspace
 * granularity. A session routinely touches many unrelated repos, sibling
 * projects, and scratch paths in one run; pi's built-in read/write/edit
 * tools have never restricted which absolute path can be touched, and
 * Lector must not either. (Real, shipped bug this fixes: read/write/edit
 * hard-locked to whatever directory the session happened to start in,
 * refusing every legitimate path outside it with a "Lector-registered
 * workspace root" error -- discovered live, in a separate session, working
 * against a completely different, unrelated repository.)
 */
export function nearestGitRoot(startDirectory: string): string | undefined {
	let dir = startDirectory;
	const fsRoot = parse(dir).root;
	while (dir !== fsRoot) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break; // defensive: dirname must be strictly ascending
		dir = parent;
	}
	return existsSync(join(fsRoot, ".git")) ? fsRoot : undefined;
}
