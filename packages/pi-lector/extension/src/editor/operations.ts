import type { ContentHash } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForPath } from "../lector-client.ts";
import { toWorkspaceRelativePath } from "../workspace-relative-path.ts";

export interface EditorFileSession {
	readonly content: string;
	/**
	 * Saves through Lector's hash-guarded `workspace.exactEdit` -- deliberately NOT the
	 * transparent stale-hash-retry behavior `createLectorWriteOperations` uses for pi's
	 * unconditional-overwrite write tool. `/editor`'s `:w` is a human editing a file they can see
	 * on screen; a genuinely concurrent external change must surface as a real, visible error
	 * (StaleExpectedHash), never be silently overwritten just because the model's write-tool
	 * contract happens to prefer that elsewhere.
	 */
	save(text: string): Promise<void>;
}

/** Opens `absolutePath` for `/editor`: one hash-guarded read, then a save() closure that tracks the hash across saves within the same session. */
export function openEditorFile(absolutePath: string): Promise<EditorFileSession> {
	return withWorkspace(
		() => workspaceForPath(absolutePath),
		async ({ workspaceId, root }) => {
			const client = await lectorClient();
			const relativePath = toWorkspaceRelativePath(root, absolutePath);
			const { content, hash } = await client.call("workspace.rawRead", { workspaceId, path: relativePath });
			let expectedHash: ContentHash | null = hash;
			return {
				content,
				async save(text: string): Promise<void> {
					const outcome = await client.callOnce("workspace.exactEdit", { workspaceId, path: relativePath, expectedHash, content: text });
					expectedHash = outcome.newHash;
				},
			};
		},
	);
}
