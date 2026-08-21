import type { FindFilesResult } from "./find-files-result.ts";
import type { TextSearchResult } from "./text-search-result.ts";

export interface TextSearchOptions {
	readonly maxMatches: number;
	/** Bound on the total bytes of matched line text returned, not on bytes scanned. */
	readonly maxBytes: number;
	/** Optional cancellation/deadline signal. Real process-backed adapters must stop scanning when aborted. */
	readonly signal?: AbortSignal;
}

export interface FindFilesOptions {
	readonly maxResults: number;
	/** Bound on the total bytes of matched path text returned, not on bytes scanned. */
	readonly maxBytes: number;
}

/**
 * TextSearchPort -- multi-file text/regex search scoped to one workspace root, and the
 * `find`-shaped half of the classic grep+find pair: locating files by path/name pattern
 * rather than by content. Both are lexical (never semantic/LSP-backed), workspace-scoped,
 * and share the same ripgrep-backed adapter -- one port, not two, for two operations that
 * are really the same tool used two ways.
 */
export interface TextSearchPort {
	search(rootPath: string, query: string, options: TextSearchOptions): Promise<TextSearchResult>;
	/** `patterns` are OR'd together -- a file matching any one of them is included, matching ripgrep's own multi-glob semantics. */
	findFiles(rootPath: string, patterns: readonly string[], options: FindFilesOptions): Promise<FindFilesResult>;
}
