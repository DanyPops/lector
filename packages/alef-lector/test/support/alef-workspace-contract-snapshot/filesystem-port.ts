/**
 * Pinned snapshot of Alef's real @dpopsuev/alef-workspace/filesystem-port contract
 * (WorkspaceFilesystemPort v1), copied verbatim from
 * /home/dpopsuev/Workspace/alef/packages/core/workspace/src/filesystem-port.ts as of
 * 2026-08-02. See git-port.ts's own snapshot header for the full rationale -- applies
 * identically here.
 */

export interface MissingWorkspaceEntry {
	readonly exists: false;
}

export interface PresentWorkspaceEntry {
	readonly exists: true;
	readonly content: string;
}

export type WorkspaceEntry = MissingWorkspaceEntry | PresentWorkspaceEntry;

export interface WorkspaceWriteResult {
	readonly previousHash: string | null;
	readonly newHash: string;
}

export interface WorkspaceFilesystemPort {
	readonly version: 1;
	readEntry(path: string): Promise<WorkspaceEntry>;
	writeEntry(path: string, expectedHash: string | null, content: string): Promise<WorkspaceWriteResult>;
}
