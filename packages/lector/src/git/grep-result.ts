export interface GitGrepMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

export interface GitGrepResult {
	readonly matches: readonly GitGrepMatch[];
	/** True when either the raw output itself was cut by maxBytes, or the parsed match count exceeded maxMatches. */
	readonly truncated: boolean;
}
