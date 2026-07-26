import { callLector, remoteErrorIs } from "./client.js";
import { registerWorkspace } from "./workspace-registration.js";

/**
 * Mirrors Alef's own WorkspaceGitPort v1 contract (@dpopsuev/alef-workspace/git-port)
 * structurally -- this package has no dependency on Alef's repo, so Alef relies on
 * TypeScript's structural typing to treat LectorGitPort as satisfying that interface.
 * Keep these shapes in sync by hand if either side's fields change.
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

/** WorkspaceGitPort backed by a real Lector daemon's workspace.gitStatus/gitLog/gitDiff. */
export class LectorGitPort {
	readonly version = 1 as const;

	constructor(private readonly root: string) {}

	async isGitRepository(): Promise<boolean> {
		try {
			await this.status();
			return true;
		} catch (error) {
			if (remoteErrorIs(error, "NotAGitRepository")) return false;
			throw error;
		}
	}

	async status(): Promise<GitStatusSummary> {
		const workspaceId = await registerWorkspace(this.root);
		const summary = await callLector("workspace.gitStatus", { workspaceId });
		return {
			files: summary.files.map((file) => ({
				path: file.path,
				renamedFrom: file.renamedFrom,
				indexStatus: file.indexStatus,
				workingDirStatus: file.workingDirStatus,
			})),
			ahead: summary.ahead,
			behind: summary.behind,
			current: summary.current,
			tracking: summary.tracking,
		};
	}

	async log(maxCount: number): Promise<readonly GitLogEntry[]> {
		const workspaceId = await registerWorkspace(this.root);
		const { entries } = await callLector("workspace.gitLog", { workspaceId, maxCount });
		return entries.map((entry) => ({
			sha: entry.sha,
			authorName: entry.authorName,
			authorEmail: entry.authorEmail,
			authoredAt: entry.authoredAt,
			message: entry.message,
		}));
	}

	async diff(ref: string | undefined, maxBytes: number): Promise<GitDiffResult> {
		const workspaceId = await registerWorkspace(this.root);
		const result = await callLector("workspace.gitDiff", { workspaceId, ref, maxBytes });
		return { diff: result.diff, truncated: result.truncated };
	}
}
