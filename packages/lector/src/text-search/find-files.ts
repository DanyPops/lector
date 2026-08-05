import { assertSafeGlobPattern } from "./assert-safe-glob-pattern.ts";
import type { FindFilesResult } from "./find-files-result.ts";
import type { FindFilesOptions, TextSearchPort } from "./port.ts";

/**
 * Validates every glob pattern before delegating to the port. Uncached, unlike searchText:
 * `rg --files` never reads a single byte of file content, so it's already cheap enough that
 * a cache would add complexity (invalidation on every file create/delete) without a measured
 * need for it.
 */
export async function findFiles(
	textSearch: TextSearchPort,
	rootPath: string,
	patterns: readonly string[],
	options: FindFilesOptions,
): Promise<FindFilesResult> {
	if (patterns.length === 0) throw new TypeError("findFiles requires at least one glob pattern");
	for (const pattern of patterns) assertSafeGlobPattern(pattern);
	return textSearch.findFiles(rootPath, patterns, options);
}
