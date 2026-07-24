import { type Dirent, existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { LanguageServerDescriptor } from "../../domain/language-server-descriptor.ts";

const SKIP_DIRECTORY_NAMES = new Set(["node_modules", "dist", "build", "out", "coverage"]);
const MAX_SCAN_DEPTH = 4;
const MAX_ENTRIES_SCANNED = 2_000;

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
 * Pick a workspace-relative file to open first so a language server has a live project to
 * search (see LspSymbolIndex's own doc comment on the "No Project." gotcha). A caller
 * should never have to know or care which file this is -- it is a pure implementation
 * detail of warming the language server, not part of the workspace's identity or the
 * query's meaning.
 *
 * Tries `commonCandidates` first (e.g. a language's usual entry-point names); falls back
 * to a bounded (depth- and entry-count-limited, per "Bound resources and outputs
 * explicitly") directory scan matching `extensions`, deterministic (alphabetically
 * sorted) so the same workspace always picks the same file.
 */
export function discoverSeedFile(rootPath: string, extensions: readonly string[], commonCandidates: readonly string[]): string {
	for (const candidate of commonCandidates) {
		if (existsSync(join(rootPath, candidate))) return candidate;
	}
	const sourceExtensions = new Set(extensions);

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
			if (scanned >= MAX_ENTRIES_SCANNED) return undefined;
			scanned++;
			const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
			if (entry.isDirectory()) {
				if (SKIP_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
				const found = visit(relativePath, depth + 1);
				if (found) return found;
			} else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
				return relativePath;
			}
		}
		return undefined;
	};

	const found = visit("", 0);
	if (!found) throw new NoSeedFileFound(rootPath, extensions);
	return found;
}

/**
 * For workspace.findSymbols called with no seedFile -- no anchor file to pick a language from.
 * Tries each descriptor's own discoverSeedFile in declared order; first real match wins.
 */
export function discoverWorkspaceDescriptor(
	rootPath: string,
	descriptors: readonly LanguageServerDescriptor[],
): { descriptor: LanguageServerDescriptor; seedFile: string } | undefined {
	for (const descriptor of descriptors) {
		try {
			const seedFile = discoverSeedFile(rootPath, descriptor.extensions, descriptor.commonSeedCandidates);
			return { descriptor, seedFile };
		} catch (error) {
			if (!(error instanceof NoSeedFileFound)) throw error;
		}
	}
	return undefined;
}
