import { existsSync, statSync } from "node:fs";
import { dirname, extname, parse } from "node:path";
import { descriptorForExtension, LANGUAGE_SERVER_DESCRIPTORS } from "../code-intelligence/language-server-descriptor.ts";
import { nearestDeclaredWorkspaceRoot, nearestGitRoot, nearestProjectRoot } from "./nearest-workspace-root.ts";

/** Every known language's own rootMarkers, deduplicated -- used when "language-project-root" is given no specific extension (a caller comparing several, possibly differently-languaged, projects at once has no single extension to pick markers from). */
const ALL_PROJECT_ROOT_MARKERS: readonly string[] = [...new Set(LANGUAGE_SERVER_DESCRIPTORS.flatMap((descriptor) => descriptor.rootMarkers))];

export type WorkspaceResolutionFallback = "filesystem-root" | "given-directory";

/**
 * One resolution request, matching pi-lector's five former client-side resolvers 1:1 by
 * strategy+fallback combination -- see the design research doc "Pi should be a thin caller:
 * logic-placement audit of pi-lector vs. lector" for the full rationale. `path` is always
 * treated as the directory to start walking upward FROM (a caller holding a file path computes
 * its own dirname() first -- a pure string operation, not real domain logic worth a round trip
 * to avoid) except for "path-or-directory", which needs the real filesystem to tell whether the
 * raw path it was given is itself already a directory.
 */
/**
 * fallback is optional on "git-root"/"language-project-root" specifically: omit it to ask "did a
 * real marker actually exist" honestly (found: false when the walk matched nothing -- e.g. a
 * session-start heuristic deciding whether cwd looks like a real git-tracked project at all, not
 * something that should auto-populate a cache for a bare scratch directory); supply it when the
 * caller always wants SOME usable root regardless (workspaceForPath/workspaceForDirectory's own
 * former unconditional `?? fallback` behavior).
 */
export type WorkspaceResolutionRequest =
	| { readonly strategy: "git-root"; readonly path: string; readonly fallback?: WorkspaceResolutionFallback }
	| { readonly strategy: "language-project-root"; readonly path: string; readonly fallback?: WorkspaceResolutionFallback; readonly extension?: string }
	| { readonly strategy: "declared-monorepo-root"; readonly path: string }
	| { readonly strategy: "path-or-directory"; readonly path: string }
	/**
	 * For an operation whose own `path` genuinely means "which workspace does this belong to" and
	 * can honestly be either an existing project directory or one specific source file -- symbol
	 * annotation's own create/get/list/refresh/scrub/restore/contain/uncontain/tree, all of which
	 * previously took dirname() unconditionally (silently resolving a project's own root directory
	 * to its *parent*, the same class of bug path-or-directory itself already fixed for
	 * populateSymbolGraph/workspaceMap/hasWarmIndex). Unlike path-or-directory, a directory
	 * resolves via language-specific project markers, not just the nearest .git, and a genuinely
	 * nonexistent path is reported explicitly (found: false, reason: "nonexistent-path") rather
	 * than silently guessed as "must be a file, take its dirname()."
	 */
	| { readonly strategy: "code-intelligence-path-or-directory"; readonly path: string };

export type WorkspaceResolutionOutcome = { readonly found: true; readonly root: string } | { readonly found: false; readonly reason?: "nonexistent-path" };

function applyFallback(path: string, fallback: WorkspaceResolutionFallback | undefined): WorkspaceResolutionOutcome {
	if (!fallback) return { found: false };
	return { found: true, root: fallback === "filesystem-root" ? parse(path).root : path };
}

function resolveLanguageProjectRoot(
	directory: string,
	extension: string | undefined,
	fallback: WorkspaceResolutionFallback | undefined,
): WorkspaceResolutionOutcome {
	const markers = extension ? (descriptorForExtension(extension)?.rootMarkers ?? []) : ALL_PROJECT_ROOT_MARKERS;
	const matched = nearestProjectRoot(directory, markers);
	return matched ? { found: true, root: matched } : applyFallback(directory, fallback);
}

/**
 * The single choke point for "which workspace root does this path belong to" -- every caller
 * (workspace.registerPath's own five former client-side equivalents, plus reference-based-
 * rename's widen-and-retry) funnels through here. Never returns the bare filesystem root as a
 * "found" project/language root even under a fallback: applyFallback's own "given-directory"
 * case can only ever return the literal starting directory, and its "filesystem-root" case is
 * the one legitimate, explicit exception (workspace.registerPath's own raw read/write/edit
 * contract: any absolute path is fair game, exactly like Pi's built-in tools already allow).
 */
export function resolveWorkspacePath(request: WorkspaceResolutionRequest): WorkspaceResolutionOutcome {
	if (request.strategy === "git-root") {
		const matched = nearestGitRoot(request.path);
		return matched ? { found: true, root: matched } : applyFallback(request.path, request.fallback);
	}
	if (request.strategy === "language-project-root") {
		return resolveLanguageProjectRoot(request.path, request.extension, request.fallback);
	}
	if (request.strategy === "declared-monorepo-root") {
		const root = nearestDeclaredWorkspaceRoot(request.path);
		return root ? { found: true, root } : { found: false };
	}
	if (request.strategy === "path-or-directory") {
		// The one strategy that needs the real filesystem to tell whether the raw path it was given
		// is itself already a directory (populateSymbolGraph/workspaceMap/hasWarmIndex's own `path`
		// genuinely means "the project itself") -- a real, previously-shipped bug: naively taking
		// dirname() of a project's own root directory (which has its own .git right there) silently
		// resolved to that directory's *parent*, mixing in every sibling project's own graph.
		// Delegates to a plain git-root walk once it knows the real starting directory -- same
		// algorithm and fallback as "git-root"/"given-directory", never language markers (matching
		// workspaceForPathOrDirectory's own former delegation to workspaceForDirectory).
		const isRealDirectory = existsSync(request.path) && statSync(request.path).isDirectory();
		const directory = isRealDirectory ? request.path : dirname(request.path);
		const matched = nearestGitRoot(directory);
		return matched ? { found: true, root: matched } : { found: true, root: directory };
	}
	// "code-intelligence-path-or-directory": a genuinely nonexistent path gets its own explicit
	// outcome rather than being silently treated as "must be a file" -- an existing directory
	// resolves via language-project-root markers on itself (no extension: a directory has none);
	// an existing file resolves via language-project-root on its own dirname()+extension, matching
	// workspaceForCodeIntelligencePath's existing per-file behavior exactly.
	if (!existsSync(request.path)) return { found: false, reason: "nonexistent-path" };
	if (statSync(request.path).isDirectory()) return resolveLanguageProjectRoot(request.path, undefined, "given-directory");
	return resolveLanguageProjectRoot(dirname(request.path), extname(request.path), "given-directory");
}
