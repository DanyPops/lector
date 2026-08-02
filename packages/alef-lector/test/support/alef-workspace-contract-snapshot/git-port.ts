/**
 * Pinned snapshot of Alef's real @dpopsuev/alef-workspace/git-port contract (WorkspaceGitPort
 * v1), copied verbatim from /home/dpopsuev/Workspace/alef/packages/core/workspace/src/git-port.ts
 * as of 2026-08-02. Never imported by src/ -- this package intentionally has no runtime or
 * build dependency on Alef's repo. Exists only so ../contract-snapshot.test.ts's compile-time
 * `satisfies` checks fail loudly the moment LectorGitPort drifts from the shape pinned here.
 *
 * This snapshot itself is not automatically re-synced -- if Alef's real git-port.ts changes,
 * this file must be updated by hand to match, at which point the compile-time check below
 * re-validates LectorGitPort against the new shape. A stale snapshot only proves "still
 * compatible with what Alef looked like on the date above," not with Alef's current HEAD.
 */

export interface GitStatusEntry {
	readonly path: string;
	readonly renamedFrom?: string;
	readonly indexStatus: string;
	readonly workingDirStatus: string;
}

export interface GitStatusSummary {
	readonly files: readonly GitStatusEntry[];
	readonly ahead: number;
	readonly behind: number;
	readonly current: string | null;
	readonly tracking: string | null;
}

export interface GitLogEntry {
	readonly sha: string;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authoredAt: string;
	readonly message: string;
}

export interface GitDiffResult {
	readonly diff: string;
	readonly truncated: boolean;
}

export interface WorkspaceGitPort {
	readonly version: 1;
	isGitRepository(): Promise<boolean>;
	status(): Promise<GitStatusSummary>;
	log(maxCount: number): Promise<readonly GitLogEntry[]>;
	diff(ref: string | undefined, maxBytes: number): Promise<GitDiffResult>;
}
