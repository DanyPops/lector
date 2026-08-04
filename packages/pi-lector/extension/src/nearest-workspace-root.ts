import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, relative } from "node:path";
import picomatch from "picomatch";

/**
 * The bare filesystem root is never a legitimate discovered project root, even if it happens
 * to contain a marker file (a stray `git init /`, a leftover `package.json`) -- matches the
 * same convention already established elsewhere in this house (oculus/survey/rust_scanner.go's
 * findCrateRoot, oculus/locator/match.go's effectiveParent: reaching "/" during a walk-up means
 * "not found", never "found here"). Confirmed live: without this, a Lector daemon registered
 * "/" as a workspace and a background job attempted to symbol-graph the entire filesystem.
 * `exists` is injectable so a test can simulate "a marker exists at the filesystem root"
 * without ever touching the real one.
 */
function walkUpForMarkers(startDirectory: string, markers: readonly string[], exists: (path: string) => boolean = existsSync): string | undefined {
	let dir = startDirectory;
	const fsRoot = parse(dir).root;
	while (dir !== fsRoot) {
		if (markers.some((marker) => exists(join(dir, marker)))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break; // defensive: dirname must be strictly ascending
		dir = parent;
	}
	return undefined;
}

/**
 * The nearest enclosing git repository root starting from (and including) a given directory,
 * or undefined if none is found (e.g. /tmp scratch files, dotfiles outside any repo, or the
 * walk reaching the filesystem root without a match). Callers choose their own fallback -- see
 * lector-client.ts's workspaceForPath (falls back to the filesystem root: any absolute path is
 * fair game for read/write/edit, exactly as Pi's built-in tools already allow) vs.
 * workspaceForDirectory (falls back to the directory itself: widening a symbol-search scope all
 * the way to the entire filesystem when a project isn't a git repo would be absurd).
 *
 * This -- not a Pi session's original cwd -- is Lector's real workspace granularity. A session
 * routinely touches many unrelated repos, sibling projects, and scratch paths in one run; Pi's
 * built-in read/write/edit tools have never restricted which absolute path can be touched, and
 * Lector must not either. (Real, shipped bug this fixes: read/write/edit hard-locked to
 * whatever directory the session happened to start in, refusing every legitimate path outside
 * it with a "Lector-registered workspace root" error -- discovered live, in a separate session,
 * working against a completely different, unrelated repository.)
 *
 * `exists` is injectable for tests -- see walkUpForMarkers.
 */
/**
 * True for the bare filesystem root itself ("/" on Linux/macOS, "C:\\" on Windows) -- the one
 * path a caller must never treat as a real project to auto-index. workspaceForPath's own
 * intentional fallback for a raw read/write of a file outside any git repo can still produce
 * this value; callers that trigger background work (auto-population, cache monitoring) off a
 * newly-registered workspace must check this explicitly rather than assuming
 * nearestGitRoot/nearestProjectRoot are the only paths that can hand them a workspace root.
 */
export function isFilesystemRoot(path: string): boolean {
	return parse(path).root === path;
}

export function nearestGitRoot(startDirectory: string, exists: (path: string) => boolean = existsSync): string | undefined {
	return walkUpForMarkers(startDirectory, [".git"], exists);
}

/**
 * Same nearest-enclosing-root walk as nearestGitRoot, but also checks a language's own root
 * markers (tsconfig.json, go.mod, Cargo.toml, ...) at each directory, nearest first -- so a
 * monorepo subproject with its own root marker resolves to itself, not the outer repo's .git.
 * Found via @arvoretech/pi-lsp comparison: without this, a file inside a monorepo subproject
 * misattributes its whole project to the repo root, handing the language server the wrong
 * rootUri (and, for TypeScript, the wrong tsconfig.json) even though a closer one exists.
 */
export function nearestProjectRoot(startDirectory: string, rootMarkers: readonly string[], exists: (path: string) => boolean = existsSync): string | undefined {
	return walkUpForMarkers(startDirectory, [...rootMarkers, ".git"], exists);
}

/** An npm/yarn/bun package.json's own "workspaces" field: either a bare glob array, or `{ packages: [...] }` (pnpm's own equivalent shape for the same field, embedded inside package.json rather than a separate pnpm-workspace.yaml). */
interface WorkspacesManifest {
	workspaces?: string[] | { packages?: string[] };
}

function readWorkspaceGlobs(packageJsonPath: string, readFile: (path: string) => string): string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFile(packageJsonPath));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { workspaces } = parsed as WorkspacesManifest;
	const globs = Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? undefined);
	return Array.isArray(globs) ? globs.filter((entry): entry is string => typeof entry === "string") : undefined;
}

/**
 * The nearest ancestor of a real project root (as found by nearestProjectRoot) whose own
 * package.json declares that project as a workspace member via npm/yarn/bun's "workspaces"
 * field -- never an arbitrary ancestor that merely happens to have its own marker file. Walks
 * upward past ancestors with no "workspaces" field (or one that doesn't actually match this
 * project's relative path) rather than stopping at the first package.json found, since an
 * intermediate directory can be a plain package with no workspaces declaration of its own.
 *
 * Mirrors how mature language tooling handles this same monorepo shape: TypeScript's tsserver
 * only widens a file's project scope to an ancestor "solution" tsconfig that explicitly lists
 * the nearer project in its own `references`, and rust-analyzer treats Cargo's `[workspace]`
 * `members` list as the authoritative multi-crate boundary rather than inferring one from
 * directory structure. This is the same idea applied to npm/yarn/bun's own declared
 * "workspaces" glob instead of a language-specific manifest.
 *
 * Returns undefined (no declared ancestor) for a plain single-package repo, or when no ancestor's
 * "workspaces" globs actually match this project -- callers must not treat an arbitrary git root
 * as an implicit stand-in.
 */
export function nearestDeclaredWorkspaceRoot(
	projectRoot: string,
	exists: (path: string) => boolean = existsSync,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | undefined {
	let dir = dirname(projectRoot);
	const fsRoot = parse(dir).root;
	while (dir !== fsRoot) {
		const packageJsonPath = join(dir, "package.json");
		if (exists(packageJsonPath)) {
			const globs = readWorkspaceGlobs(packageJsonPath, readFile);
			const relativePath = relative(dir, projectRoot);
			if (globs?.some((glob) => picomatch(glob)(relativePath))) return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break; // defensive: dirname must be strictly ascending
		dir = parent;
	}
	return undefined;
}
