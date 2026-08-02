import type { MutationHistoryEntry } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForPath } from "./lector-client.ts";
import { toWorkspaceRelativePath } from "./workspace-relative-path.ts";

/** Thin wrapper over Lector's mutation history: every successful edit is recorded, and any entry can be reverted -- guarded the same way every other Lector write is. */
export interface MutationHistoryOperations {
	list(absolutePath: string, maxResults: number): Promise<readonly MutationHistoryEntry[]>;
	revert(absolutePath: string, entryId: string): Promise<{ path: string; newHash: string | null }>;
}

export function createMutationHistoryOperations(): MutationHistoryOperations {
	return {
		list(absolutePath, maxResults) {
			return withWorkspace(
				() => workspaceForPath(absolutePath),
				async ({ workspaceId, root }) => {
					const client = await lectorClient();
					const path = toWorkspaceRelativePath(root, absolutePath);
					const { entries } = await client.call("workspace.mutationHistory", { workspaceId, path, maxResults });
					return entries;
				},
			);
		},
		revert(absolutePath, entryId) {
			return withWorkspace(
				() => workspaceForPath(absolutePath),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.callOnce("workspace.revertMutation", { workspaceId, entryId });
				},
			);
		},
	};
}
