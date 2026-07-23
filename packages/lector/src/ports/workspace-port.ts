import type { ContentHash } from "../domain/content-hash.ts";

/** A workspace entry that does not (yet) exist. Distinguished from empty content. */
export interface MissingWorkspaceEntry {
	readonly exists: false;
}

/** A workspace entry that exists, with its raw content. */
export interface PresentWorkspaceEntry {
	readonly exists: true;
	readonly content: string;
}

export type WorkspaceEntry = MissingWorkspaceEntry | PresentWorkspaceEntry;

/**
 * WorkspacePort — the role a driven adapter plays for Lector's core: give the
 * domain raw access to one workspace's entries, and apply an expected-hash-
 * guarded edit atomically. `writeEntry` must reject a stale `expectedHash`
 * (see StaleExpectedHash) rather than silently overwrite.
 *
 * Implemented by InMemoryWorkspace for the walking skeleton and contract
 * tests, and later by a local-filesystem adapter for real workspaces.
 */
export interface WorkspacePort {
	readEntry(path: string): Promise<WorkspaceEntry>;

	/**
	 * @param expectedHash The hash the caller last observed at `path`, or
	 *   `null` to assert the path does not yet exist.
	 * @throws StaleExpectedHash when the entry's current hash does not match
	 *   `expectedHash`.
	 */
	writeEntry(
		path: string,
		expectedHash: ContentHash | null,
		content: string,
	): Promise<{ previousHash: ContentHash | null; newHash: ContentHash }>;
}
