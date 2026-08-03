import type { DirectoryListing, WorkspaceId } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForPathOrDirectory } from "../lector-client.ts";

/** Oil's own default (view_options.show_hidden = false): dotfiles/dotdirs excluded unless explicitly toggled. Toggling is deferred (v2) -- this always applies for now, matching the tool's own out-of-the-box behavior. */
function isHidden(name: string): boolean {
	return name.startsWith(".");
}

/**
 * Backs the /editor no-path Oil-style explorer: one resolved workspace for the whole browsing
 * session (navigating between directories never re-resolves a workspace, just changes which
 * relative path is listed), plus the four mutation primitives its :w diff-and-apply step needs.
 *
 * deleteFile is not a thin pass-through: workspace.deleteEntry is hash-guarded and the explorer
 * only ever has a directory *listing* (no content hash) for the line being deleted, so it reads
 * the file's current hash immediately before deleting it -- an extra round trip, acceptable for
 * an infrequent interactive action, not a hot path.
 */
export interface DirectoryExplorerSession {
	readonly root: string;
	readonly workspaceId: WorkspaceId;
	listDirectory(relativePath: string): Promise<DirectoryListing>;
	createFile(relativePath: string): Promise<void>;
	createDirectory(relativePath: string): Promise<void>;
	renamePath(oldRelativePath: string, newRelativePath: string): Promise<void>;
	deleteFile(relativePath: string): Promise<void>;
	deleteDirectory(relativePath: string): Promise<void>;
}

export function openDirectoryExplorer(absoluteDirectory: string): Promise<DirectoryExplorerSession> {
	return withWorkspace(
		() => workspaceForPathOrDirectory(absoluteDirectory),
		async ({ workspaceId, root }) => {
			const client = await lectorClient();
			return {
				root,
				workspaceId,
				listDirectory: async (relativePath: string): Promise<DirectoryListing> => {
					const listing = await client.call("workspace.listDirectory", { workspaceId, path: relativePath });
					return { ...listing, entries: listing.entries.filter((entry) => !isHidden(entry.name)) };
				},
				createFile: async (relativePath: string) => {
					await client.callOnce("workspace.exactEdit", { workspaceId, path: relativePath, expectedHash: null, content: "" });
				},
				createDirectory: async (relativePath: string) => {
					await client.callOnce("workspace.createDirectory", { workspaceId, path: relativePath });
				},
				renamePath: async (oldRelativePath: string, newRelativePath: string) => {
					await client.callOnce("workspace.renamePath", { workspaceId, oldPath: oldRelativePath, newPath: newRelativePath });
				},
				deleteFile: async (relativePath: string) => {
					const { hash } = await client.call("workspace.rawRead", { workspaceId, path: relativePath });
					await client.callOnce("workspace.deleteEntry", { workspaceId, path: relativePath, expectedHash: hash });
				},
				deleteDirectory: async (relativePath: string) => {
					await client.callOnce("workspace.deleteDirectory", { workspaceId, path: relativePath });
				},
			};
		},
	);
}
