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
function walkUpForMarkers(startDirectory: string, markers: readonly string[]): string | undefined {
	let dir = startDirectory;
	const fsRoot = parse(dir).root;
	while (dir !== fsRoot) {
		if (markers.some((marker) => existsSync(join(dir, marker)))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break; // defensive: dirname must be strictly ascending
		dir = parent;
	}
	return markers.some((marker) => existsSync(join(fsRoot, marker))) ? fsRoot : undefined;
}

export function nearestGitRoot(startDirectory: string): string | undefined {
	return walkUpForMarkers(startDirectory, [".git"]);
}

/**
 * Same nearest-enclosing-root walk as nearestGitRoot, but also checks a language's own root
 * markers (tsconfig.json, go.mod, Cargo.toml, ...) at each directory, nearest first -- so a
 * monorepo subproject with its own root marker resolves to itself, not the outer repo's .git.
 * Found via @arvoretech/pi-lsp comparison: without this, a file inside a monorepo subproject
 * misattributes its whole project to the repo root, handing the language server the wrong
 * rootUri (and, for TypeScript, the wrong tsconfig.json) even though a closer one exists.
 */
export function nearestProjectRoot(startDirectory: string, rootMarkers: readonly string[]): string | undefined {
	return walkUpForMarkers(startDirectory, [...rootMarkers, ".git"]);
}
