import type { MutationHistoryEntry } from "@danypops/lector";
import { withWorkspace, workspaceForPath } from "../lector-client.ts";
import { invokeLectorVehicleOperation, type LectorVehicleCall } from "../vehicle-client.ts";
import { toWorkspaceRelativePath } from "../workspace-relative-path.ts";

const MAX_INTERNAL_HISTORY_LOOKUP_RESULTS = 2_000;

export interface MutationTransactionRevertOutcome {
	readonly transactionId: string;
	readonly reverted: readonly { readonly path: string; readonly newHash: string | null }[];
}

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
	revertTransaction(absolutePath: string, transactionId: string, call: LectorVehicleCall): Promise<MutationTransactionRevertOutcome>;
}

async function listResolvedHistory(
	workspaceId: string,
	root: string,
	absolutePath: string,
	maxResults: number,
	call: LectorVehicleCall,
): Promise<readonly MutationHistoryEntry[]> {
	const relativePath = toWorkspaceRelativePath(root, absolutePath);
	// Single-file edits historically record the caller's workspace-relative path, while LSP
	// WorkspaceEdits record canonical absolute paths. Query both identities until the daemon's
	// stored-history migration can normalize old entries, then deduplicate by immutable entry id.
	const paths = relativePath === absolutePath ? [absolutePath] : [relativePath, absolutePath];
	const pages = await Promise.all(
		paths.map((path) =>
			invokeLectorVehicleOperation<{ entries: readonly MutationHistoryEntry[] }>(
				"workspace.mutationHistory",
				{ workspaceId, path, maxResults },
				MUTATION_HISTORY_READ_PERMISSIONS,
				call,
			),
		),
	);
	const byId = new Map<string, MutationHistoryEntry>();
	for (const page of pages) for (const entry of page.entries) byId.set(entry.id, entry);
	return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, maxResults);
}

export function createMutationHistoryOperations(): MutationHistoryOperations {
	return {
		list(absolutePath, maxResults, call) {
			return withWorkspace(
				() => workspaceForPath(absolutePath),
				({ workspaceId, root }) => listResolvedHistory(workspaceId, root, absolutePath, maxResults, call),
			);
		},
		revert(absolutePath, entryId, call) {
			return withWorkspace(
				() => workspaceForPath(absolutePath),
				async ({ workspaceId, root }) => {
					const entries = await listResolvedHistory(workspaceId, root, absolutePath, MAX_INTERNAL_HISTORY_LOOKUP_RESULTS, call);
					const target = entries.find((entry) => entry.id === entryId);
					if (!target) throw new Error(`mutation history entry "${entryId}" is not recorded for "${absolutePath}" -- list that path again before reverting`);
					if (target.transactionId !== null) {
						throw new Error(
							`mutation history entry "${entryId}" belongs to multi-file transaction "${target.transactionId}" -- refusing a partial revert; use action=revert-transaction with transactionId`,
						);
					}
					return invokeLectorVehicleOperation<{ path: string; newHash: string | null }>(
						"workspace.revertMutation",
						{ workspaceId, entryId },
						MUTATION_HISTORY_WRITE_PERMISSIONS,
						call,
					);
				},
			);
		},
		revertTransaction(absolutePath, transactionId, call) {
			return withWorkspace(
				() => workspaceForPath(absolutePath),
				({ workspaceId }) =>
					invokeLectorVehicleOperation<MutationTransactionRevertOutcome>(
						"workspace.revertMutationTransaction",
						{ workspaceId, transactionId },
						MUTATION_HISTORY_WRITE_PERMISSIONS,
						call,
					),
			);
		},
	};
}
