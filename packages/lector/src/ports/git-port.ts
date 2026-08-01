import type { GitDiffResult } from "../domain/git-diff-result.ts";
import type { GitLogEntry } from "../domain/git-log-entry.ts";
import type { GitStatusSummary } from "../domain/git-status.ts";

/**
 * GitPort -- the role a driven adapter plays for read-only git queries
 * against a workspace's repository. Deliberately read-only: Lector's git
 * layer never constructs a caller-influenced `-c` config override or
 * mutating flag (clone/push/merge), the exact surface simple-git's own
 * history shows is where git CLI injection CVEs live. A workspace with no
 * `.git` directory is a real, expected case (not every registered
 * workspace is a git repository), not an error condition callers must
 * special-case per operation.
 */
export interface GitPort {
	/** Undefined when the workspace root is not inside a git repository. */
	isGitRepository(): Promise<boolean>;
	status(): Promise<GitStatusSummary>;
	/** Most recent commits first, bounded to maxCount. */
	log(maxCount: number): Promise<readonly GitLogEntry[]>;
	/** Diff against `ref` (defaults to HEAD) of the current working tree, bounded to maxBytes. */
	diff(ref: string | undefined, maxBytes: number): Promise<GitDiffResult>;
	/**
	 * A path's exact blob content at `ref`, resolved relative to this GitPort's own workspace
	 * root (not necessarily the repository's top level -- the same convention every other `path`
	 * argument in Lector already follows). Undefined when `path` does not exist at `ref` -- a
	 * real, expected case (the file was added/removed/renamed between versions), never an error.
	 * A genuinely invalid `ref` still throws.
	 */
	showFile(ref: string, path: string): Promise<string | undefined>;
}
