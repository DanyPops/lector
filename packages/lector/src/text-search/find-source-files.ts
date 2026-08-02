import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { extname, join, sep } from "node:path";
import ignore from "ignore";
import { SKIP_DIRECTORY_NAMES } from "./skip-directories.ts";

function toPosixPath(relativePath: string): string {
	return sep === "/" ? relativePath : relativePath.split(sep).join("/");
}

/**
 * Rewrites one .gitignore line so a nested .gitignore's own patterns, which are relative to that
 * file's own directory (gitignore(5)), can be added to a single ignore() instance that matches
 * paths relative to the scan root instead. A pattern with no slash (or only a trailing one) is
 * unanchored -- it matches at any depth under its own directory, not just directly inside it --
 * so it gets a `**\/` inserted; a pattern with a leading or internal slash is already anchored to
 * its own directory and only needs that directory prefixed on. Deliberately does not handle
 * backslash-escaped `\#`/`\!` (real but rare in practice); those pass through as literal text
 * exactly as they do in the un-rewritten root .gitignore case.
 */
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

/** Loads one directory's own .gitignore (if any) into the shared filter; a no-op, not an error, when the directory has none. */
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

/**
 * Bounded (entry-count-limited, skips node_modules/.git/build output, hidden dirs, and every
 * .gitignore-matched path -- root and nested) recursive source-file scan.
 */
export function findSourceFiles(rootPath: string, isSourceExtension: (extension: string) => boolean, maxFiles: number): string[] {
	const files: string[] = [];
	let scanned = 0;
	const filter = ignore();
	loadGitignore(filter, rootPath, "");

	const visit = (relativeDir: string): void => {
		if (scanned >= maxFiles) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(join(rootPath, relativeDir), { withFileTypes: true, encoding: "utf-8" });
		} catch {
			return;
		}
		for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
			if (scanned >= maxFiles) return;
			const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
			if (filter.ignores(toPosixPath(relativePath))) continue;
			if (entry.isDirectory()) {
				if (SKIP_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
				loadGitignore(filter, rootPath, relativePath);
				visit(relativePath);
			} else if (entry.isFile() && isSourceExtension(extname(entry.name))) {
				scanned++;
				files.push(relativePath);
			}
		}
	};

	visit("");
	return files;
}
