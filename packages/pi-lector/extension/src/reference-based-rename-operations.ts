import type { OperationOutputs } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForCodeIntelligencePath } from "./lector-client.ts";

/**
 * Thin wrapper over Lector's non-LSP reference-based rename: moves a file and rewrites every
 * static import/export specifier the workspace's own populated symbol graph knows references it.
 * `fromPath` resolves its own workspace (workspaceForCodeIntelligencePath -- this spawns a real
 * language server), matching every other code-intelligence operation's convention.
 */
export interface ReferenceBasedRenameOperations {
	rename(fromPath: string, toPath: string, maxFiles: number, maxSymbolsPerFile: number): Promise<OperationOutputs["workspace.referenceBasedRename"]>;
}

export function createReferenceBasedRenameOperations(): ReferenceBasedRenameOperations {
	return {
		async rename(fromPath, toPath, maxFiles, maxSymbolsPerFile) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(fromPath),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.referenceBasedRename", { workspaceId, fromPath, toPath, maxFiles, maxSymbolsPerFile });
				},
			);
		},
	};
}
