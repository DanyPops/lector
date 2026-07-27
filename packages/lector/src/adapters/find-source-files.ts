import { type Dirent, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { SKIP_DIRECTORY_NAMES } from "../domain/skip-directories.ts";

/** Bounded (entry-count-limited, skips node_modules/.git/build output and hidden dirs) recursive source-file scan. */
export function findSourceFiles(rootPath: string, isSourceExtension: (extension: string) => boolean, maxFiles: number): string[] {
	const files: string[] = [];
	let scanned = 0;

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
			if (entry.isDirectory()) {
				if (SKIP_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
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
