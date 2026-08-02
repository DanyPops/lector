/** Unified diff text, bounded per "Bound resources and outputs explicitly" -- a huge diff is truncated, never silently unbounded. */
export interface GitDiffResult {
	readonly diff: string;
	readonly truncated: boolean;
}
