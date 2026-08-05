import { type MutableRegistry, type OperationInputs, type OperationOutputs, resolveWorkspace, type WorkspaceId } from "../service.ts";
import type { SymbolGraphPort } from "../symbol-graph/port.ts";
import { computeWorkspaceMap } from "../workspace/workspace-map.ts";

export function createWorkspaceMapHandler(graph: (workspaceId: WorkspaceId) => SymbolGraphPort) {
	return async (registry: MutableRegistry, input: OperationInputs["workspace.map"]): Promise<OperationOutputs["workspace.map"]> => {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		return computeWorkspaceMap(graph(input.workspaceId), workspace, {
			maxNodes: input.maxNodes,
			maxEdges: input.maxEdges,
			maxEntries: input.maxEntries,
			maxBytes: input.maxBytes,
		});
	};
}
