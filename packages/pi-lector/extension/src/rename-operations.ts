import type { OperationOutputs } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForCodeIntelligencePath } from "./lector-client.ts";

/**
 * Thin wrappers over Lector's LSP-driven prepareRename/rename -- position-based (path + 1-indexed
 * line + character), matching every other code-intelligence operation's convention. `path`
 * resolves its own workspace per call (workspaceForCodeIntelligencePath -- spawns a real
 * language server).
 */
export interface RenameOperations {
	prepareRename(path: string, line: number, character: number): Promise<OperationOutputs["workspace.prepareRename"]>;
	rename(path: string, line: number, character: number, newName: string): Promise<OperationOutputs["workspace.rename"]>;
}

export function createRenameOperations(): RenameOperations {
	return {
		async prepareRename(path, line, character) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.prepareRename", { workspaceId, path, line, character });
				},
			);
		},
		async rename(path, line, character, newName) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.callOnce("workspace.rename", { workspaceId, path, line, character, newName });
				},
			);
		},
	};
}
