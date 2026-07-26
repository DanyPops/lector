import type { ContentHash } from "@danypops/lector";
import { callLector, remoteErrorIs } from "./client.js";
import { registerWorkspace } from "./workspace-registration.js";

/** Mirrors Alef's WorkspaceFilesystemPort v1 contract (@dpopsuev/alef-workspace/filesystem-port) structurally. */
export interface MissingWorkspaceEntry {
	readonly exists: false;
}

export interface PresentWorkspaceEntry {
	readonly exists: true;
	readonly content: string;
}

export type WorkspaceEntry = MissingWorkspaceEntry | PresentWorkspaceEntry;

/** Rejects a write whose expectedHash no longer matches the entry's current state. */
export class StaleWorkspaceWrite extends Error {
	constructor(
		readonly path: string,
		readonly expectedHash: string | null,
	) {
		super(`stale write at "${path}": content changed since expectedHash ${expectedHash ?? "null (expected not-yet-existing)"} was observed`);
		this.name = "StaleWorkspaceWrite";
	}
}

export interface WorkspaceWriteResult {
	readonly previousHash: string | null;
	readonly newHash: string;
}

function asContentHash(hash: string | null): ContentHash | null {
	if (hash === null) return null;
	// ContentHash is branded specifically so a raw string can't reach it by accident; this is
	// the one intentional boundary crossing, for a value this port's own writeEntry previously
	// returned as a hash.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return hash as ContentHash;
}

/** WorkspaceFilesystemPort backed by a real Lector daemon's workspace.rawRead/exactEdit. */
export class LectorFilesystemPort {
	readonly version = 1 as const;

	constructor(private readonly root: string) {}

	async readEntry(path: string): Promise<WorkspaceEntry> {
		const workspaceId = await registerWorkspace(this.root);
		try {
			const read = await callLector("workspace.rawRead", { workspaceId, path });
			return { exists: true, content: read.content };
		} catch (error) {
			if (remoteErrorIs(error, "WorkspaceEntryNotFound")) return { exists: false };
			throw error;
		}
	}

	async writeEntry(path: string, expectedHash: string | null, content: string): Promise<WorkspaceWriteResult> {
		const workspaceId = await registerWorkspace(this.root);
		try {
			const outcome = await callLector("workspace.exactEdit", { workspaceId, path, expectedHash: asContentHash(expectedHash), content });
			return { previousHash: outcome.previousHash, newHash: outcome.newHash };
		} catch (error) {
			if (remoteErrorIs(error, "StaleExpectedHash")) throw new StaleWorkspaceWrite(path, expectedHash);
			throw error;
		}
	}
}
