import type { MutationHistoryEntry } from "@danypops/lector";
import { withWorkspace, workspaceForPath } from "../lector-client.ts";
import { invokeLectorVehicleOperation, type LectorVehicleCall } from "../vehicle-client.ts";
import { toWorkspaceRelativePath } from "../workspace-relative-path.ts";

/** Match MUTATION_HISTORY_READ_PERMISSIONS/MUTATION_HISTORY_WRITE_PERMISSIONS' own declared values server-side (mutation-history/operation-registration.ts). */
const MUTATION_HISTORY_READ_PERMISSIONS = ["workspace:read"];
const MUTATION_HISTORY_WRITE_PERMISSIONS = ["workspace:write"];

/**
 * Thin wrapper over Lector's mutation history, dispatched through invokeLectorVehicleOperation:
 * every successful edit is recorded, and any entry can be reverted -- guarded the same way every
 * other Lector write is.
 */
export interface MutationHistoryOperations {
	list(absolutePath: string, maxResults: number, call: LectorVehicleCall): Promise<readonly MutationHistoryEntry[]>;
	revert(absolutePath: string, entryId: string, call: LectorVehicleCall): Promise<{ path: string; newHash: string | null }>;
}

export function createMutationHistoryOperations(): MutationHistoryOperations {
	return {
		list(absolutePath, maxResults, call) {
			return withWorkspace(
				() => workspaceForPath(absolutePath),
				async ({ workspaceId, root }) => {
					const path = toWorkspaceRelativePath(root, absolutePath);
					const { entries } = await invokeLectorVehicleOperation<{ entries: readonly MutationHistoryEntry[] }>(
						"workspace.mutationHistory",
						{ workspaceId, path, maxResults },
						MUTATION_HISTORY_READ_PERMISSIONS,
						call,
					);
					return entries;
				},
			);
		},
		revert(absolutePath, entryId, call) {
			return withWorkspace(
				() => workspaceForPath(absolutePath),
				({ workspaceId }) =>
					invokeLectorVehicleOperation<{ path: string; newHash: string | null }>(
						"workspace.revertMutation",
						{ workspaceId, entryId },
						MUTATION_HISTORY_WRITE_PERMISSIONS,
						call,
					),
			);
		},
	};
}
