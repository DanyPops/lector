import { type OperationOutputs, remoteErrorIs } from "@danypops/lector";
import { lectorClient, type ResolvedWorkspace, withWorkspace, workspaceForCodeIntelligencePath, workspaceForDeclaredMonorepoRoot } from "../lector-client.ts";

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
 *
 * autoPopulate (Lector's own opt-in recovery from a "not-cached" graph) is applied carefully, not
 * blanket-enabled: only once the correct FINAL scope is already known, never on a speculative
 * first attempt that might still need widening. If a declared monorepo ancestor exists, the
 * narrow project's own first attempt runs WITHOUT autoPopulate (so a genuinely never-populated
 * narrow project still throws and triggers the widen-to-declared-root fallback below, exactly as
 * before -- auto-populating the too-narrow scope here could make a rename "succeed" while
 * silently missing a real cross-package reference the wider scope would have caught). Once widened
 * to the declared root (or when no wider ancestor exists at all, meaning the narrow project IS the
 * correct final scope), autoPopulate is safe and turned on -- one call converges instead of two.
 */
export interface ReferenceBasedRenameOperations {
	rename(fromPath: string, toPath: string, maxFiles: number, maxSymbolsPerFile: number): Promise<OperationOutputs["workspace.referenceBasedRename"]>;
}

export function createReferenceBasedRenameOperations(): ReferenceBasedRenameOperations {
	return {
		async rename(fromPath, toPath, maxFiles, maxSymbolsPerFile) {
			const performRename = async ({ workspaceId }: ResolvedWorkspace, autoPopulate: boolean) => {
				const client = await lectorClient();
				return client.callOnce("workspace.referenceBasedRename", { workspaceId, fromPath, toPath, maxFiles, maxSymbolsPerFile, autoPopulate });
			};

			const narrow = await workspaceForCodeIntelligencePath(fromPath);
			const declared = await workspaceForDeclaredMonorepoRoot(narrow.root);
			if (!declared) {
				// No wider declared ancestor -- the narrow project IS the correct, final scope, so
				// auto-populating it directly is exactly as safe as the already-widened case below.
				return withWorkspace(
					() => Promise.resolve(narrow),
					(resolved) => performRename(resolved, true),
				);
			}
			try {
				return await withWorkspace(
					() => Promise.resolve(narrow),
					(resolved) => performRename(resolved, false),
				);
			} catch (error) {
				if (!remoteErrorIs(error, "ReferenceBasedRenameRequiresFreshGraph")) throw error;
				return withWorkspace(
					() => Promise.resolve(declared),
					(resolved) => performRename(resolved, true),
				);
			}
		},
	};
}
