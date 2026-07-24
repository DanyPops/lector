import type { ContentHash } from "../domain/content-hash.ts";
import type { WorkspaceEntry, WorkspacePort } from "../ports/workspace-port.ts";

/** Raised when a write targets a workspace the caller doesn't own, like a RepoFetcherPort checkout. */
export class WorkspaceIsReadOnly extends Error {
	constructor(readonly path: string) {
		super(`workspace is read-only; cannot write "${path}" -- it's a foreign checkout, not one the caller owns`);
		this.name = "WorkspaceIsReadOnly";
	}
}

/** Wraps any WorkspacePort to reject every write. Reads pass through unchanged. */
export class ReadOnlyWorkspace implements WorkspacePort {
	constructor(private readonly inner: WorkspacePort) {}

	readEntry(path: string): Promise<WorkspaceEntry> {
		return this.inner.readEntry(path);
	}

	async writeEntry(path: string, _expectedHash: ContentHash | null, _content: string): Promise<{ previousHash: ContentHash | null; newHash: ContentHash }> {
		throw new WorkspaceIsReadOnly(path);
	}
}
