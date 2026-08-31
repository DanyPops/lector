/** One matched line from a text search, with the matched span within it. */
export interface TextSearchMatch {
	/** Workspace-relative path. */
	readonly path: string;
	readonly lineNumber: number;
	readonly line: string;
	/** True when `line` is a bounded excerpt rather than the complete matched line. */
	readonly lineTruncated?: true;
	/** Original UTF-8 byte offset where a bounded excerpt starts; omitted for a complete line. */
	readonly lineStartByte?: number;
	/** UTF-8 byte offsets within the returned `line`, matching ripgrep's offset semantics. */
	readonly matchStart: number;
	readonly matchEnd: number;
}

export interface LexicalSearchProvenance {
	readonly kind: "lexical";
	readonly backend: "ripgrep" | "fff";
	readonly indexState: "loading" | "stale" | "ready" | "degraded" | "unavailable" | "bypassed";
	readonly indexedFiles?: number;
	readonly indexSizeBytes?: number;
}

/** `truncated` reports aggregate result loss from maxMatches/maxBytes; an excerpted individual line reports `lineTruncated` on its own match instead. */
export interface TextSearchResult {
	readonly matches: readonly TextSearchMatch[];
	readonly truncated: boolean;
	/** Distinguishes indexed lexical search from its fresh ripgrep fallback; never semantic provenance. */
	readonly provenance?: LexicalSearchProvenance;
}
