import { existsSync, readdirSync, type Dirent } from "node:fs";
import { extname, join } from "node:path";

const COMMON_SEED_CANDIDATES = ["src/index.ts", "index.ts", "src/main.ts", "main.ts", "src/index.tsx", "index.tsx", "src/index.js", "index.js"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRECTORY_NAMES = new Set(["node_modules", "dist", "build", "out", "coverage"]);
const MAX_SCAN_DEPTH = 4;
const MAX_ENTRIES_SCANNED = 2_000;

/** Raised when no TypeScript/JavaScript source file could be found to warm a language server with. */
export class NoSeedFileFound extends Error {
	constructor(readonly rootPath: string) {
		super(`no TypeScript/JavaScript source file found under "${rootPath}" to warm the language server with`);
		this.name = "NoSeedFileFound";
	}
}

/**
 * Pick a workspace-relative file to open first so tsserver has a live project to search
 * (see TypescriptSymbolIndex's own doc comment on the "No Project." gotcha). A caller
 * should never have to know or care which file this is -- it is a pure implementation
 * detail of warming the language server, not part of the workspace's identity or the
 * query's meaning.
 *
 * Tries a short list of common entry-point names first; falls back to a bounded (depth-
 * and entry-count-limited, per "Bound resources and outputs explicitly") directory scan,
 * deterministic (alphabetically sorted) so the same workspace always picks the same file.
 */
export function discoverSeedFile(rootPath: string): string {
	for (const candidate of COMMON_SEED_CANDIDATES) {
		if (existsSync(join(rootPath, candidate))) return candidate;
	}

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
			} else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
				return relativePath;
			}
		}
		return undefined;
	};

	const found = visit("", 0);
	if (!found) throw new NoSeedFileFound(rootPath);
	return found;
}
