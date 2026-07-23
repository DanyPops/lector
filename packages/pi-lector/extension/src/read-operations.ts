import type { ReadOperations } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { lectorClient, workspaceForPath } from "./lector-client.ts";
import { toWorkspaceRelativePath } from "./workspace-relative-path.ts";

/**
 * Lector's core domain (RawRead/ExpectedHashEdit) is deliberately text-only
 * for this pass -- binary content is an open, not-yet-decided design
 * question (doc 38db976d). Images are the one case pi's built-in read tool
 * must still handle correctly, so they read directly from the local
 * filesystem, bypassing Lector entirely, rather than corrupting binary
 * bytes through a text round-trip. Extension-based, not content-sniffed:
 * good enough to match pi's own defaultReadOperations behavior for the
 * common case without depending on pi-coding-agent's internal detector.
 */
const IMAGE_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

function imageMimeTypeFor(absolutePath: string): string | undefined {
	const dot = absolutePath.lastIndexOf(".");
	if (dot === -1) return undefined;
	return IMAGE_MIME_TYPES_BY_EXTENSION[absolutePath.slice(dot).toLowerCase()];
}

/**
 * ReadOperations backed by a running Lector daemon for text; images bypass
 * Lector (see above). The workspace for each call is resolved from the
 * absolute path being read, not a fixed cwd -- see workspaceForPath.
 */
export function createLectorReadOperations(): ReadOperations {
	return {
		async readFile(absolutePath) {
			if (imageMimeTypeFor(absolutePath)) return fsReadFile(absolutePath);

			const client = await lectorClient();
			const { workspaceId, root } = await workspaceForPath(absolutePath);
			const relativePath = toWorkspaceRelativePath(root, absolutePath);
			const { content } = await client.call("workspace.rawRead", { workspaceId, path: relativePath });
			return Buffer.from(content, "utf-8");
		},

		async access(absolutePath) {
			if (imageMimeTypeFor(absolutePath)) {
				await fsAccess(absolutePath, constants.R_OK);
				return;
			}

			// workspace.rawRead itself rejects a missing entry (WorkspaceEntryNotFound) -- exactly
			// the "not accessible" signal pi's read/edit tools expect access() to throw for.
			const client = await lectorClient();
			const { workspaceId, root } = await workspaceForPath(absolutePath);
			const relativePath = toWorkspaceRelativePath(root, absolutePath);
			await client.call("workspace.rawRead", { workspaceId, path: relativePath });
		},

		detectImageMimeType: (absolutePath) => Promise.resolve(imageMimeTypeFor(absolutePath)),
	};
}
