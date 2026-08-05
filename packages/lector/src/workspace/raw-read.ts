import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import type { WorkspacePort } from "./port.ts";

/** The result of reading a workspace entry as-is, with no structural interpretation. */
export interface RawRead {
	readonly path: string;
	readonly content: string;
	readonly hash: ContentHash;
}

/** Raised when rawRead is asked for a path the workspace does not have. */
export class WorkspaceEntryNotFound extends Error {
	constructor(readonly path: string) {
		super(`no workspace entry at "${path}"`);
		this.name = "WorkspaceEntryNotFound";
	}
}

/** Read a workspace entry's raw content and current hash. */
export async function rawRead(workspace: WorkspacePort, path: string): Promise<RawRead> {
	const entry = await workspace.readEntry(path);
	if (!entry.exists) throw new WorkspaceEntryNotFound(path);
	return { path, content: entry.content, hash: contentHashOf(entry.content) };
}
