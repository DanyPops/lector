import { type Dirent, existsSync, readdirSync } from "node:fs";
import { extname, join, sep } from "node:path";
import type { LanguageServerDescriptor } from "../../domain/language-server-descriptor.ts";
import { refineTypescriptSeedFile } from "./typescript-project-files.ts";

const SKIP_DIRECTORY_NAMES = new Set(["node_modules", "dist", "build", "out", "coverage"]);
const MAX_SCAN_DEPTH = 4;
const MAX_ENTRIES_SCANNED = 2_000;
const MAX_WORKSPACE_DESCRIPTORS = 32;

/** Raised when no matching source file could be found to warm a language server with. */
export class NoSeedFileFound extends Error {
	constructor(
		readonly rootPath: string,
		readonly extensions: readonly string[],
	) {
		super(`no source file matching [${extensions.join(", ")}] found under "${rootPath}" to warm the language server with`);
		this.name = "NoSeedFileFound";
	}
}

/**
 * True when `relativeFilePath` has `marker` in its own directory or any ancestor directory up
 * to and including rootPath -- i.e. whether a language server would actually associate this
 * file with a real, config-backed project, as opposed to treating it as an orphan file with no
 * project coverage (a standalone root-level *.config.ts next to a monorepo root that has no
 * root tsconfig.json is exactly this case: real extension match, zero project coverage).
 */
function hasMarkerAncestor(rootPath: string, relativeFilePath: string, marker: string): boolean {
	const parts = relativeFilePath.split(sep);
	parts.pop();
	for (let i = parts.length; i >= 0; i--) {
		if (existsSync(join(rootPath, ...parts.slice(0, i), marker))) return true;
	}
	return false;
}

/**
 * Pick a workspace-relative file to open first so a language server has a live project to
 * search (see LspSymbolIndex's own doc comment on the "No Project." gotcha). A caller
 * should never have to know or care which file this is -- it is a pure implementation
 * detail of warming the language server, not part of the workspace's identity or the
 * query's meaning.
 *
 * Tries `commonCandidates` first (e.g. a language's usual entry-point names); falls back to a
 * bounded (depth- and entry-count-limited, per "Bound resources and outputs explicitly")
 * directory scan matching `extensions`, deterministic (alphabetically sorted). Among files found
 * during that scan, prefers one with `rootMarkers[0]` (e.g. tsconfig.json) among its ancestors --
 * a real, previously-undetected bug (confirmed against this project's own monorepo root) let a
 * standalone root-level eslint.config.ts win purely by alphabetical luck over any real project
 * file, silently limiting workspace/symbol to a project that doesn't include the actual source
 * tree at all. Only falls back to the first alphabetical match when nothing in the scanned
 * subtree has real project coverage.
 */
export function discoverSeedFile(
	rootPath: string,
	extensions: readonly string[],
	commonCandidates: readonly string[],
	rootMarkers: readonly string[] = [],
): string {
	for (const candidate of commonCandidates) {
		if (existsSync(join(rootPath, candidate))) return candidate;
	}
	const sourceExtensions = new Set(extensions);
	const primaryMarker = rootMarkers[0];
	let fallback: string | undefined;

	let scanned = 0;
	const visit = (relativeDir: string, depth: number): string | undefined => {
		if (depth > MAX_SCAN_DEPTH) return undefined;
		let entries: Dirent[];
		try {
			entries = readdirSync(join(rootPath, relativeDir), { withFileTypes: true, encoding: "utf-8" });
		} catch {
			return undefined;
		}
		const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

		for (const entry of sorted) {
			if (scanned >= MAX_ENTRIES_SCANNED) return fallback;
			scanned++;
			const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
			if (entry.isDirectory()) {
				if (SKIP_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
				const found = visit(relativePath, depth + 1);
				if (found) return found;
			} else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
				if (!primaryMarker || hasMarkerAncestor(rootPath, relativePath, primaryMarker)) return relativePath;
				fallback ??= relativePath;
			}
		}
		return undefined;
	};

	const found = visit("", 0) ?? fallback;
	if (!found) throw new NoSeedFileFound(rootPath, extensions);
	return found;
}

/**
 * discoverSeedFile plus a TypeScript-specific refinement pass -- the generic ancestor-marker
 * heuristic isn't sufficient for TypeScript specifically: a real tsconfig.json ancestor doesn't
 * mean that tsconfig's own include/exclude actually covers the candidate (confirmed empirically
 * against this project's own monorepo, see typescript-project-files.ts). Kept as an explicit,
 * named special case here rather than a generic hook on LanguageServerDescriptor -- only one
 * language currently needs it, and forcing every descriptor to carry an unused hook field would
 * be speculative generality this project's own conventions argue against.
 */
export function resolveSeedFile(rootPath: string, descriptor: LanguageServerDescriptor): string {
	const candidate = discoverSeedFile(rootPath, descriptor.extensions, descriptor.commonSeedCandidates, descriptor.rootMarkers);
	return descriptor.languageId === "typescript" ? refineTypescriptSeedFile(rootPath, candidate) : candidate;
}

/** Detects every auto-enabled language in descriptor order; each language keeps the same bounded seed scan. */
export function discoverWorkspaceDescriptors(
	rootPath: string,
	descriptors: readonly LanguageServerDescriptor[],
): readonly { descriptor: LanguageServerDescriptor; seedFile: string }[] {
	if (descriptors.length > MAX_WORKSPACE_DESCRIPTORS) throw new TypeError(`workspace descriptor count exceeds ${MAX_WORKSPACE_DESCRIPTORS}`);
	const discovered: { descriptor: LanguageServerDescriptor; seedFile: string }[] = [];
	for (const descriptor of descriptors) {
		if (descriptor.workspaceDiscovery === "explicit-only") continue;
		try {
			discovered.push({ descriptor, seedFile: resolveSeedFile(rootPath, descriptor) });
		} catch (error) {
			if (!(error instanceof NoSeedFileFound)) throw error;
		}
	}
	return discovered;
}

/** Compatibility helper for callers that still need one deterministic primary language. */
export function discoverWorkspaceDescriptor(
	rootPath: string,
	descriptors: readonly LanguageServerDescriptor[],
): { descriptor: LanguageServerDescriptor; seedFile: string } | undefined {
	return discoverWorkspaceDescriptors(rootPath, descriptors)[0];
}
