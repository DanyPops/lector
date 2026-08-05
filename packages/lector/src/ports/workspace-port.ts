import type { ContentHash } from "../content-identity/content-hash.ts";

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
	/**
	 * Normalizes `path` (relative or already-absolute) to this workspace's own
	 * canonical identity for it -- the same string this workspace would use
	 * internally regardless of which form a caller supplied. Callers that need
	 * to derive a stable cross-call identity from a path (e.g. matching a
	 * symbol graph node's own stored path) must resolve through this first,
	 * rather than assuming every path argument arrives pre-normalized.
	 */
	resolvePath(path: string): string;

	readEntry(path: string): Promise<WorkspaceEntry>;

	/**
	 * @param expectedHash The hash the caller last observed at `path`, or
	 *   `null` to assert the path does not yet exist.
	 * @throws StaleExpectedHash when the entry's current hash does not match
	 *   `expectedHash`.
	 */
	writeEntry(path: string, expectedHash: ContentHash | null, content: string): Promise<{ previousHash: ContentHash | null; newHash: ContentHash }>;

	/**
	 * Removes an entry, guarded the same way writeEntry is -- `expectedHash` must match the
	 * entry's current hash. A missing entry has no hash to match, so deleting one that doesn't
	 * exist rejects via the same StaleExpectedHash a mismatched hash would (no separate
	 * not-found error): a caller must always have actually read the entry first, never delete
	 * on a guess.
	 * @throws StaleExpectedHash when the entry's current hash does not match `expectedHash`.
	 */
	deleteEntry(path: string, expectedHash: ContentHash): Promise<{ previousHash: ContentHash }>;
}
