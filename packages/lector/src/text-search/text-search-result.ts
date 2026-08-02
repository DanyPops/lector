/** One matched line from a text search, with the matched span within it. */
export interface TextSearchMatch {
	/** Workspace-relative path. */
	readonly path: string;
	readonly lineNumber: number;
	readonly line: string;
	readonly matchStart: number;
	readonly matchEnd: number;
}

/** `truncated` is honest, not silent: true whenever maxMatches or maxBytes cut the search short. */
export interface TextSearchResult {
	readonly matches: readonly TextSearchMatch[];
	readonly truncated: boolean;
}
