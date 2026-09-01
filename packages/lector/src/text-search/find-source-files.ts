import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { extname, join, sep } from "node:path";
import ignore from "ignore";
import { SKIP_DIRECTORY_NAMES } from "./skip-directories.ts";

function toPosixPath(relativePath: string): string {
	return sep === "/" ? relativePath : relativePath.split(sep).join("/");
}

function rewriteForSubdirectory(pattern: string, relativeDir: string): string {
	const negated = pattern.startsWith("!");
	let body = negated ? pattern.slice(1) : pattern;
	const directoryOnly = body.length > 1 && body.endsWith("/");
	if (directoryOnly) body = body.slice(0, -1);
	const leadingSlash = body.startsWith("/");
	if (leadingSlash) body = body.slice(1);
	const anchored = leadingSlash || body.includes("/");
	const rewritten = anchored ? `${relativeDir}/${body}` : `${relativeDir}/**/${body}`;
	return `${negated ? "!" : ""}${rewritten}${directoryOnly ? "/" : ""}`;
}

function loadGitignore(filter: ignore.Ignore, rootPath: string, relativeDir: string): void {
	let contents: string;
	try {
		contents = readFileSync(join(rootPath, relativeDir, ".gitignore"), "utf-8");
	} catch {
		return;
	}
	for (const line of contents.split(/\r?\n/)) {
		if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
		filter.add(relativeDir ? rewriteForSubdirectory(line, toPosixPath(relativeDir)) : line);
	}
}

export interface SourceFileSelectionCoverage {
	readonly scannedEntries: number;
	readonly truncated: boolean;
	readonly scopes: readonly { readonly scope: string; readonly files: number }[];
	readonly scopeOmittedCount: number;
	readonly languages: readonly { readonly extension: string; readonly files: number }[];
	readonly languageOmittedCount: number;
}

export interface SourceFileSelection {
	readonly files: readonly string[];
	readonly coverage: SourceFileSelectionCoverage;
}

interface DirectoryCursor {
	readonly relativeDir: string;
	readonly entries: readonly Dirent[];
	index: number;
}

const ENTRY_SCAN_MULTIPLIER = 100;
const MIN_ENTRY_SCAN_BOUND = 1_000;
const MAX_COVERAGE_STRATA = 100;

function scopeOf(relativePath: string): string {
	const [topLevel, child] = toPosixPath(relativePath).split("/");
	if (!topLevel) return ".";
	if (child && ["apps", "crates", "libs", "packages", "services"].includes(topLevel)) return `${topLevel}/${child}`;
	return topLevel;
}

/**
 * Selects source files with a deterministic round-robin directory walk. Each active directory
 * contributes at most one source file per turn, so an alphabetically early package cannot consume
 * the whole file budget before sibling packages and languages receive coverage.
 */
export function selectSourceFiles(rootPath: string, isSourceExtension: (extension: string) => boolean, maxFiles: number): SourceFileSelection {
	if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new RangeError("maxFiles must be a positive safe integer");
	const filter = ignore();
	loadGitignore(filter, rootPath, "");
	const queue: DirectoryCursor[] = [];
	const files: string[] = [];
	const scopes = new Map<string, number>();
	const languages = new Map<string, number>();
	const maxScannedEntries = Math.max(MIN_ENTRY_SCAN_BOUND, maxFiles * ENTRY_SCAN_MULTIPLIER);
	let scannedEntries = 0;
	let truncated = false;

	function enqueue(relativeDir: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(join(rootPath, relativeDir), { withFileTypes: true, encoding: "utf-8" });
		} catch {
			return;
		}
		queue.push({ relativeDir, entries: [...entries].sort((left, right) => left.name.localeCompare(right.name)), index: 0 });
	}

	enqueue("");
	while (queue.length > 0 && files.length < maxFiles && scannedEntries < maxScannedEntries) {
		const cursor = queue.shift();
		if (!cursor) break;
		let selected = false;
		while (cursor.index < cursor.entries.length && !selected && scannedEntries < maxScannedEntries) {
			const entry = cursor.entries[cursor.index++];
			if (!entry) continue;
			scannedEntries++;
			const relativePath = cursor.relativeDir ? join(cursor.relativeDir, entry.name) : entry.name;
			if (filter.ignores(toPosixPath(relativePath))) continue;
			if (entry.isDirectory()) {
				if (SKIP_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
				loadGitignore(filter, rootPath, relativePath);
				enqueue(relativePath);
				continue;
			}
			const extension = extname(entry.name);
			if (!entry.isFile() || !isSourceExtension(extension)) continue;
			files.push(relativePath);
			scopes.set(scopeOf(relativePath), (scopes.get(scopeOf(relativePath)) ?? 0) + 1);
			languages.set(extension, (languages.get(extension) ?? 0) + 1);
			selected = true;
		}
		if (cursor.index < cursor.entries.length) queue.push(cursor);
	}
	if (queue.length > 0 || scannedEntries >= maxScannedEntries) truncated = true;
	const scopeCoverage = [...scopes].sort(([left], [right]) => left.localeCompare(right)).map(([scope, count]) => ({ scope, files: count }));
	const languageCoverage = [...languages].sort(([left], [right]) => left.localeCompare(right)).map(([extension, count]) => ({ extension, files: count }));
	return {
		files,
		coverage: {
			scannedEntries,
			truncated,
			scopes: scopeCoverage.slice(0, MAX_COVERAGE_STRATA),
			scopeOmittedCount: Math.max(0, scopeCoverage.length - MAX_COVERAGE_STRATA),
			languages: languageCoverage.slice(0, MAX_COVERAGE_STRATA),
			languageOmittedCount: Math.max(0, languageCoverage.length - MAX_COVERAGE_STRATA),
		},
	};
}

/** Returns the bounded selected file list for callers that do not need coverage metadata. */
export function findSourceFiles(rootPath: string, isSourceExtension: (extension: string) => boolean, maxFiles: number): string[] {
	return [...selectSourceFiles(rootPath, isSourceExtension, maxFiles).files];
}
