export interface GitHistoryGrepBounds {
	/** Number of commits skipped in the deterministic all-ref topological traversal. */
	readonly commitOffset: number;
	readonly maxCommits: number;
	readonly maxMatches: number;
	/** Maximum stdout bytes retained from the bounded git grep process. */
	readonly maxBytes: number;
	readonly deadlineMs: number;
}

export interface GitHistoryGrepMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
	/** Newest commit in the selected traversal page containing this exact path/line/text tuple. */
	readonly commit: string;
	/** Number of selected commits containing this exact path/line/text tuple. */
	readonly occurrences: number;
}

export interface GitHistoryGrepResult {
	readonly matches: readonly GitHistoryGrepMatch[];
	readonly scannedCommits: number;
	readonly commitsTruncated: boolean;
	readonly nextCommitOffset?: number;
	readonly truncated: boolean;
	readonly deadlineReached: boolean;
	readonly provenance: {
		readonly scope: "all-refs";
		readonly traversal: "topo-order";
		readonly binaryFiles: "excluded";
		readonly deduplication: "path-line-text";
		readonly commitOffset: number;
	};
}
