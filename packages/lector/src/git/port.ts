import type { GitDiffResult } from "./diff-result.ts";
import type { GitLogEntry } from "./log-entry.ts";
import type { GitStatusSummary } from "./status.ts";

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
	/** The exact commit `ref` resolves to right now, without checking out or mutating anything. A genuinely invalid `ref` throws GitRevisionNotFound. */
	resolveCommit(ref: string): Promise<string>;
	/**
	 * Creates a detached linked worktree at `targetDir`, checked out to `ref`, without touching
	 * this GitPort's own checked-out branch or working tree -- the mechanism behind
	 * workspace.gitWorktreeAdd's real, LSP-capable cross-ref queries (Tier 2: a full read-only
	 * project at another ref, not just a text/blob-level query). Self-healing: a `targetDir` left
	 * behind by a prior process's own worktree (the in-memory workspace registry does not survive
	 * a daemon restart, but the on-disk worktree and git's own admin entry for it do) is cleared
	 * and retried once, rather than surfacing a stale-path failure to the caller.
	 */
	addWorktree(ref: string, targetDir: string): Promise<{ commit: string }>;
	/** Removes a worktree previously created by addWorktree, deleting `targetDir` from disk and its entry from git's own worktree admin list. Safe to call even if `targetDir` was already removed from disk out-of-band -- git's own stale admin entry is pruned either way. */
	removeWorktree(targetDir: string): Promise<void>;
}
