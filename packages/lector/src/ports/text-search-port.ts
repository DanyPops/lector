import type { TextSearchResult } from "../domain/text-search-result.ts";

export interface TextSearchOptions {
	readonly maxMatches: number;
	/** Bound on the total bytes of matched line text returned, not on bytes scanned. */
	readonly maxBytes: number;
}

/** TextSearchPort -- multi-file text/regex search scoped to one workspace root. */
export interface TextSearchPort {
	search(rootPath: string, query: string, options: TextSearchOptions): Promise<TextSearchResult>;
}
