/**
 * Tracks which absolute root path each workspaceId this contribution has seen actually came
 * from -- the one thing a daemon restart's in-memory workspace registry wipe can't tell a caller
 * on its own, since UnknownWorkspace carries only the id, never the path that produced it.
 * `lector.workspace.open` is the only place a root path is ever known; every later command only
 * ever receives the id, so this is the seam that makes recovery possible at all.
 */
export interface WorkspaceRootRegistry {
	remember(workspaceId: string, rootPath: string): void;
	recall(workspaceId: string): string | undefined;
	forgetAll(): void;
}

export function createWorkspaceRootRegistry(): WorkspaceRootRegistry {
	const roots = new Map<string, string>();
	return {
		remember(workspaceId, rootPath) {
			roots.set(workspaceId, rootPath);
		},
		recall(workspaceId) {
			return roots.get(workspaceId);
		},
		forgetAll() {
			roots.clear();
		},
	};
}
