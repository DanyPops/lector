import { type ContentHash, remoteErrorIs } from "@danypops/lector";
import type { EditOperations } from "@earendil-works/pi-coding-agent";
import { lectorClient, withWorkspace, workspaceForPath } from "../lector-client.ts";
import { toWorkspaceRelativePath } from "../workspace-relative-path.ts";

/**
 * EditOperations backed by Lector's hash-guarded exactEdit. The workspace
 * for each call is resolved from the absolute path being edited, not a
 * fixed cwd -- see workspaceForPath.
 *
 * pi's own EditOperations interface has no seam for passing a hash from
 * readFile to writeFile -- it calls ops.readFile, computes the oldText/
 * newText replacement itself, then calls ops.writeFile(absolutePath, content)
 * with no memory of what was read. readFile() here stashes the hash it just
 * observed in a short-lived per-absolutePath slot; writeFile() consumes
 * (and clears) it as exactEdit's expectedHash. This is safe because pi's
 * built-in edit tool already serializes readFile-then-writeFile for one
 * absolutePath through withFileMutationQueue -- no other mutation on the
 * same path can land between this readFile and this writeFile.
 *
 * A StaleExpectedHash here means the file changed on disk after the model's
 * oldText was computed against a specific earlier read -- it surfaces as a
 * real edit failure, not a silent retry: retrying would mean re-reading
 * fresh content the model never saw and applying an oldText match computed
 * against stale content, which could silently corrupt the file.
 */
export function createLectorEditOperations(): EditOperations {
	const observedHashByPath = new Map<string, ContentHash>();

	return {
		async readFile(absolutePath) {
			return withWorkspace(
				() => workspaceForPath(absolutePath),
				async ({ workspaceId, root }) => {
					const client = await lectorClient();
					const relativePath = toWorkspaceRelativePath(root, absolutePath);
					const { content, hash } = await client.call("workspace.rawRead", { workspaceId, path: relativePath });
					observedHashByPath.set(absolutePath, hash);
					return Buffer.from(content, "utf-8");
				},
			);
		},

		async writeFile(absolutePath, content) {
			const expectedHash = observedHashByPath.get(absolutePath) ?? null;
			observedHashByPath.delete(absolutePath);
			await withWorkspace(
				() => workspaceForPath(absolutePath),
				async ({ workspaceId, root }) => {
					const client = await lectorClient();
					const relativePath = toWorkspaceRelativePath(root, absolutePath);
					try {
						await client.callOnce("workspace.exactEdit", { workspaceId, path: relativePath, expectedHash, content });
					} catch (error) {
						if (remoteErrorIs(error, "StaleExpectedHash")) {
							throw new Error(`"${relativePath}" changed on disk since it was last read; re-read the file and retry the edit.`);
						}
						throw error;
					}
				},
			);
		},

		async access(absolutePath) {
			// workspace.rawRead itself rejects a missing entry -- exactly the "not accessible"
			// signal pi's edit tool expects access() to throw for.
			await withWorkspace(
				() => workspaceForPath(absolutePath),
				async ({ workspaceId, root }) => {
					const client = await lectorClient();
					const relativePath = toWorkspaceRelativePath(root, absolutePath);
					await client.call("workspace.rawRead", { workspaceId, path: relativePath });
				},
			);
		},
	};
}
