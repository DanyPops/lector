import { type OperationOutputs, remoteErrorIs } from "@danypops/lector";
import { lectorClient, type ResolvedWorkspace, withWorkspace, workspaceForCodeIntelligencePath, workspaceForProjectDirectory } from "../lector-client.ts";
import { nearestDeclaredWorkspaceRoot } from "../nearest-workspace-root.ts";

/**
 * Thin wrapper over Lector's non-LSP reference-based rename: moves a file and rewrites every
 * static import/export specifier the workspace's own populated symbol graph knows references it.
 * `fromPath` resolves its own workspace (workspaceForCodeIntelligencePath -- this spawns a real
 * language server), matching every other code-intelligence operation's convention.
 *
 * On ReferenceBasedRenameRequiresFreshGraph (the narrow per-file project was never populated),
 * retries once against the nearest ANCESTOR whose own package.json "workspaces" field actually
 * declares that project as a member -- never an arbitrary ancestor. This lets a caller populate
 * the whole declared monorepo once (workspace_cache pointed at the repo root) and still rename a
 * file inside one of its member packages, without collapsing genuinely unrelated sibling projects
 * that were never declared together into one workspace identity.
 */
export interface ReferenceBasedRenameOperations {
	rename(fromPath: string, toPath: string, maxFiles: number, maxSymbolsPerFile: number): Promise<OperationOutputs["workspace.referenceBasedRename"]>;
}

export function createReferenceBasedRenameOperations(): ReferenceBasedRenameOperations {
	return {
		async rename(fromPath, toPath, maxFiles, maxSymbolsPerFile) {
			const performRename = async ({ workspaceId }: ResolvedWorkspace) => {
				const client = await lectorClient();
				return client.callOnce("workspace.referenceBasedRename", { workspaceId, fromPath, toPath, maxFiles, maxSymbolsPerFile });
			};

			try {
				return await withWorkspace(() => workspaceForCodeIntelligencePath(fromPath), performRename);
			} catch (error) {
				if (!remoteErrorIs(error, "ReferenceBasedRenameRequiresFreshGraph")) throw error;
				const { root: narrowRoot } = await workspaceForCodeIntelligencePath(fromPath);
				const declaredRoot = nearestDeclaredWorkspaceRoot(narrowRoot);
				if (!declaredRoot) throw error;
				return withWorkspace(() => workspaceForProjectDirectory(declaredRoot), performRename);
			}
		},
	};
}
