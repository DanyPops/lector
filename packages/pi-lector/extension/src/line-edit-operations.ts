import { type LineEdit, type LineEditOutcome, type LineHash, lineHashOf } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForPath } from "./lector-client.ts";
import { toWorkspaceRelativePath } from "./workspace-relative-path.ts";

/**
 * Thin wrapper over workspace.lineEdit -- distinct from the generic edit tool (backed by
 * exactEdit's whole-file hash guard, see edit-operations.ts): every edit here is guarded by
 * its own referenced line(s)' hash, so a concurrent change to a line no edit references never
 * invalidates this one. `path` is an absolute file path, the same convention edit-operations.ts
 * already uses -- the workspace is resolved from the file itself, not a separate directory arg.
 */
export interface LineEditOperations {
	lineEdit(path: string, edits: readonly LineEdit[]): Promise<LineEditOutcome>;
	/** Pure, no daemon round trip -- computes the hash a line must still hold from content the caller already has (e.g. from a prior read), rather than requiring a dedicated "give me line hashes" read operation. */
	lineHash(line: string): LineHash;
}

export function createLectorLineEditOperations(): LineEditOperations {
	return {
		async lineEdit(path, edits) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId, root }) => {
					const client = await lectorClient();
					const relativePath = toWorkspaceRelativePath(root, path);
					return client.call("workspace.lineEdit", { workspaceId, path: relativePath, edits });
				},
			);
		},
		lineHash(line) {
			return lineHashOf(line);
		},
	};
}
