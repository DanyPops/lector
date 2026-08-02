/** One file's status, exposing index (staged) and working-directory (unstaged) status separately rather than a combined code -- see `git status --porcelain` for the full status-letter table. */
export interface GitStatusEntry {
	readonly path: string;
	/** Present only for a rename/copy entry -- the path this one was renamed/copied from. */
	readonly renamedFrom?: string;
	readonly indexStatus: string;
	readonly workingDirStatus: string;
}

/** The working tree's overall status: files plus branch tracking state. */
export interface GitStatusSummary {
	readonly files: readonly GitStatusEntry[];
	readonly ahead: number;
	readonly behind: number;
	readonly current: string | null;
	readonly tracking: string | null;
}
