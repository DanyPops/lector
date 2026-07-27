import type { ContentHash, EditOutcome } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForPath } from "./lector-client.ts";
import { toWorkspaceRelativePath } from "./workspace-relative-path.ts";

/**
 * Thin wrapper over workspace.applyPatch -- distinct from both the generic edit tool
 * (whole-file replace) and line_edit (per-line hash guards): applies a real unified diff's
 * hunks, guarded by one whole-file expectedHash (a patch inherently describes a
 * whole-file transformation from a known pre-image). `path` is an absolute file path, the
 * same convention edit-operations.ts and line-edit-operations.ts already use.
 */
export interface ApplyPatchOperations {
	applyPatch(path: string, expectedHash: ContentHash, patchText: string): Promise<EditOutcome>;
}

export function createLectorApplyPatchOperations(): ApplyPatchOperations {
	return {
		async applyPatch(path, expectedHash, patchText) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId, root }) => {
					const client = await lectorClient();
					const relativePath = toWorkspaceRelativePath(root, path);
					return client.call("workspace.applyPatch", { workspaceId, path: relativePath, expectedHash, patchText });
				},
			);
		},
	};
}
