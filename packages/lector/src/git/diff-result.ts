import type { GitDiffFile } from "./unified-diff.ts";

/** Unified diff text plus its parsed file/hunk structure, bounded per "Bound resources and outputs explicitly". */
export interface GitDiffResult {
	readonly diff: string;
	readonly files: readonly GitDiffFile[];
	readonly truncated: boolean;
}
