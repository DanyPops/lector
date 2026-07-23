import type { ContentHash } from "./content-hash.ts";
import type { WorkspacePort } from "../ports/workspace-port.ts";

/**
 * An edit intent: write `content` to `path`, guarded by the hash the caller
 * last observed there. `expectedHash: null` asserts the path does not yet
 * exist (a create).
 */
export interface ExpectedHashEdit {
	readonly path: string;
	readonly expectedHash: ContentHash | null;
	readonly content: string;
}

/** The committed result of an exact edit. */
export interface EditOutcome {
	readonly path: string;
	readonly previousHash: ContentHash | null;
	readonly newHash: ContentHash;
}

/**
 * Raised when an edit's `expectedHash` no longer matches the workspace:
 * something else changed (or created, or removed) the entry first. The edit
 * is rejected outright rather than silently overwriting — callers must
 * re-observe the entry and retry with a fresh expectedHash.
 */
export class StaleExpectedHash extends Error {
	constructor(
		readonly path: string,
		readonly expectedHash: ContentHash | null,
		readonly actualHash: ContentHash | null,
	) {
		super(`stale expected hash at "${path}": expected ${expectedHash ?? "(absent)"}, found ${actualHash ?? "(absent)"}`);
		this.name = "StaleExpectedHash";
	}
}

/** Apply an expected-hash-guarded edit to a workspace entry. */
export async function exactEdit(workspace: WorkspacePort, edit: ExpectedHashEdit): Promise<EditOutcome> {
	const { previousHash, newHash } = await workspace.writeEntry(edit.path, edit.expectedHash, edit.content);
	return { path: edit.path, previousHash, newHash };
}
