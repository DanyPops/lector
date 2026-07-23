import { remoteErrorIs, type ContentHash } from "@danypops/lector";
import type { WriteOperations } from "@earendil-works/pi-coding-agent";
import { lectorClient, workspaceIdForCwd } from "./lector-client.ts";
import { toWorkspaceRelativePath } from "./workspace-relative-path.ts";

const MAX_STALE_HASH_RETRIES = 3;

/**
 * WriteOperations backed by Lector's hash-guarded exactEdit.
 *
 * pi's write tool is unconditional overwrite by its own documented contract
 * ("Creates the file if it doesn't exist, overwrites if it does"), so unlike
 * edit, a stale hash here does not mean the model's intent is now wrong --
 * it means a concurrent external change landed between our read and our
 * write, and the model still wants its content to be exactly what it asked
 * for. Retried transparently (bounded) by re-observing the current hash and
 * retrying, rather than surfacing StaleExpectedHash to a caller whose tool
 * contract never mentioned hashes at all.
 */
export function createLectorWriteOperations(cwd: string): WriteOperations {
	async function currentHash(client: Awaited<ReturnType<typeof lectorClient>>, workspaceId: string, relativePath: string): Promise<ContentHash | null> {
		try {
			const current = await client.call("workspace.rawRead", { workspaceId, path: relativePath });
			return current.hash;
		} catch {
			return null; // no existing entry -- exactEdit's create semantics
		}
	}

	return {
		async writeFile(absolutePath, content) {
			const client = await lectorClient();
			const workspaceId = await workspaceIdForCwd(cwd);
			const relativePath = toWorkspaceRelativePath(cwd, absolutePath);

			let expectedHash = await currentHash(client, workspaceId, relativePath);

			for (let attempt = 0; attempt < MAX_STALE_HASH_RETRIES; attempt++) {
				try {
					await client.call("workspace.exactEdit", { workspaceId, path: relativePath, expectedHash, content });
					return;
				} catch (error) {
					if (!remoteErrorIs(error, "StaleExpectedHash") || attempt === MAX_STALE_HASH_RETRIES - 1) throw error;
					expectedHash = await currentHash(client, workspaceId, relativePath);
				}
			}
		},

		async mkdir() {
			// LocalFilesystemWorkspace's writeEntry already creates parent directories
			// (mkdir(dirname(absolute), { recursive: true })) as part of every write --
			// there is nothing left for this hook to do.
		},
	};
}
