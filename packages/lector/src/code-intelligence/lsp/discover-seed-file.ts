import { type Dirent, existsSync, readdirSync } from "node:fs";
import { extname, join, sep } from "node:path";
import type { LanguageServerDescriptor } from "../../code-intelligence/language-server-descriptor.ts";
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

interface OpenSeedTarget {
	readonly descriptor: LanguageServerDescriptor;
	readonly sourceExtensions: ReadonlySet<string>;
	readonly primaryMarker: string | undefined;
	markerMatch: string | undefined;
	fallback: string | undefined;
}

/**
 * Finds a seed candidate for every still-open target in ONE shared breadth-first traversal,
 * instead of one independent depth-first-per-descriptor scan each spending its own full budget.
 * Two real defects a per-descriptor depth-first scan has: (1) an alphabetically-early subtree
 * can be walked all the way to MAX_SCAN_DEPTH before any shallower sibling is even visited, so a
 * large early subtree can exhaust the whole budget before a later language's real source tree is
 * ever reached; (2) each descriptor re-walks the same tree from scratch, multiplying total scan
 * cost by the descriptor count. Breadth-first order visits every entry at a given depth before
 * descending further, so a shallow directory like `src/` is always seen long before a deep scan
 * of an unrelated wide sibling could exhaust the shared budget. One shared budget (rather than
 * one per descriptor) also means the traversal actually completes faster: no single unrelated
 * subtree gets scanned once per language.
 */
function visitCandidateEntry(rootPath: string, relativePath: string, entry: Dirent, open: Set<OpenSeedTarget>): void {
	if (!entry.isFile()) return;
	const extension = extname(entry.name);
	for (const target of open) {
		if (!target.sourceExtensions.has(extension)) continue;
		if (!target.primaryMarker || hasMarkerAncestor(rootPath, relativePath, target.primaryMarker)) {
			target.markerMatch = relativePath;
			open.delete(target);
		} else {
			target.fallback ??= relativePath;
		}
	}
}

/**
 * Returns whether the shared entry budget was exhausted before the traversal could finish --
 * i.e. whether any still-unresolved target's absence is merely unproven rather than confirmed.
 * A target with no match after a non-truncated scan really has no matching file anywhere within
 * bounds; the same empty result after a truncated scan means only that the scan never got far
 * enough to say either way.
 */
function collectSharedSeedCandidates(rootPath: string, targets: readonly OpenSeedTarget[]): boolean {
	const open = new Set(targets);
	if (open.size === 0) return false;
	let scanned = 0;
	let truncated = false;
	// Every directory at the current depth is read and then drained in round-robin, one entry
	// each per round, rather than fully draining one directory before its sibling gets a turn.
	// Without this, a single alphabetically-early directory with many entries at one depth (e.g.
	// 3,000 generated asset buckets) can consume the entire shared budget by itself before a
	// sibling directory holding the actually-relevant source files is ever touched -- true
	// breadth-first level order alone isn't enough once a level itself is unevenly sized.
	let currentLevelDirs: readonly string[] = [""];
	for (let depth = 0; currentLevelDirs.length > 0 && depth <= MAX_SCAN_DEPTH && open.size > 0 && scanned < MAX_ENTRIES_SCANNED; depth++) {
		const iterators: { relativeDir: string; entries: Dirent[]; index: number }[] = [];
		for (const relativeDir of currentLevelDirs) {
			let entries: Dirent[];
			try {
				entries = readdirSync(join(rootPath, relativeDir), { withFileTypes: true, encoding: "utf-8" });
			} catch {
				continue;
			}
			iterators.push({ relativeDir, entries: [...entries].sort((a, b) => a.name.localeCompare(b.name)), index: 0 });
		}
		const nextLevelDirs: string[] = [];
		let madeProgress = true;
		while (madeProgress && open.size > 0 && scanned < MAX_ENTRIES_SCANNED) {
			madeProgress = false;
			for (const it of iterators) {
				if (it.index >= it.entries.length) continue;
				if (scanned >= MAX_ENTRIES_SCANNED) {
					truncated = true;
					break;
				}
				madeProgress = true;
				const entry = it.entries[it.index];
				it.index++;
				if (!entry) continue;
				scanned++;
				const relativePath = it.relativeDir ? join(it.relativeDir, entry.name) : entry.name;
				if (entry.isDirectory()) {
					if (SKIP_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
					if (depth + 1 <= MAX_SCAN_DEPTH) nextLevelDirs.push(relativePath);
					continue;
				}
				visitCandidateEntry(rootPath, relativePath, entry, open);
				if (open.size === 0) break;
			}
		}
		currentLevelDirs = nextLevelDirs;
	}
	// Directories still queued for a depth beyond MAX_SCAN_DEPTH, or a level that still had
	// candidates when open/budget conditions stopped the outer loop, are real unscanned tree --
	// distinct from "the scan reached the end of every candidate on its own".
	if (open.size > 0 && (currentLevelDirs.length > 0 || scanned >= MAX_ENTRIES_SCANNED)) truncated = true;
	return truncated;
}

interface WorkspaceDescriptorDiscovery {
	readonly discovered: readonly { descriptor: LanguageServerDescriptor; seedFile: string }[];
	/** Eligible languages for which no seed file was found -- see `truncated` before treating any of these as confirmed absent. */
	readonly omittedLanguageIds: readonly string[];
	/**
	 * True when the shared scan hit its entry-count or depth bound while at least one language was
	 * still unresolved. An omission alongside `truncated: true` is inconclusive, not evidence the
	 * language is actually absent from the workspace -- the scan simply never got far enough to
	 * tell. `false` means every omitted language really has no matching file within scan bounds.
	 */
	readonly truncated: boolean;
}

function discoverWorkspaceDescriptorsDetailed(rootPath: string, descriptors: readonly LanguageServerDescriptor[]): WorkspaceDescriptorDiscovery {
	if (descriptors.length > MAX_WORKSPACE_DESCRIPTORS) throw new TypeError(`workspace descriptor count exceeds ${MAX_WORKSPACE_DESCRIPTORS}`);
	const eligible = descriptors.filter((descriptor) => descriptor.workspaceDiscovery !== "explicit-only");
	const resolved = new Map<LanguageServerDescriptor, string>();
	const needsScan: OpenSeedTarget[] = [];
	for (const descriptor of eligible) {
		const commonMatch = descriptor.commonSeedCandidates.find((candidate) => existsSync(join(rootPath, candidate)));
		if (commonMatch) {
			resolved.set(descriptor, commonMatch);
			continue;
		}
		needsScan.push({
			descriptor,
			sourceExtensions: new Set(descriptor.extensions),
			primaryMarker: descriptor.rootMarkers[0],
			markerMatch: undefined,
			fallback: undefined,
		});
	}
	const truncated = collectSharedSeedCandidates(rootPath, needsScan);
	for (const target of needsScan) {
		const found = target.markerMatch ?? target.fallback;
		if (found) resolved.set(target.descriptor, found);
	}
	const discovered: { descriptor: LanguageServerDescriptor; seedFile: string }[] = [];
	const omittedLanguageIds: string[] = [];
	for (const descriptor of eligible) {
		const rawSeedFile = resolved.get(descriptor);
		if (rawSeedFile === undefined) {
			omittedLanguageIds.push(descriptor.languageId);
			continue;
		}
		discovered.push({ descriptor, seedFile: descriptor.languageId === "typescript" ? refineTypescriptSeedFile(rootPath, rawSeedFile) : rawSeedFile });
	}
	return { discovered, omittedLanguageIds, truncated: truncated && omittedLanguageIds.length > 0 };
}

/** Detects every auto-enabled language in descriptor order via one shared bounded scan. */
export function discoverWorkspaceDescriptors(
	rootPath: string,
	descriptors: readonly LanguageServerDescriptor[],
): readonly { descriptor: LanguageServerDescriptor; seedFile: string }[] {
	return discoverWorkspaceDescriptorsDetailed(rootPath, descriptors).discovered;
}

/**
 * `discoverWorkspaceDescriptors` plus explicit coverage: which eligible languages were omitted,
 * and whether that omission is confirmed absence or merely an inconclusive, budget-truncated
 * scan. Population and cache-freshness callers that need to report "omitted, reason unknown"
 * versus "definitely not present" should use this instead of the bare discovered list.
 */
export function discoverWorkspaceSourceCoverage(rootPath: string, descriptors: readonly LanguageServerDescriptor[]): WorkspaceDescriptorDiscovery {
	return discoverWorkspaceDescriptorsDetailed(rootPath, descriptors);
}

/** Compatibility helper for callers that still need one deterministic primary language. */
export function discoverWorkspaceDescriptor(
	rootPath: string,
	descriptors: readonly LanguageServerDescriptor[],
): { descriptor: LanguageServerDescriptor; seedFile: string } | undefined {
	return discoverWorkspaceDescriptors(rootPath, descriptors)[0];
}
