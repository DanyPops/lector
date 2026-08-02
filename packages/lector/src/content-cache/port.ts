import type { ContentHash } from "../domain/content-hash.ts";

/**
 * A symbol as derivable purely from content -- deliberately NOT WorkspaceSymbol:
 * WorkspaceSymbol.location.path is a property of which *path* currently holds
 * this content, not a property of the content itself. Doc 38db976d states two
 * different files with byte-identical content share one cache entry; if this
 * type carried a path, the second file to query a shared hash would get back
 * the *first* file's path attached to its own symbols -- a real, silent
 * correctness bug this type exists specifically to make impossible. Callers
 * reattach the current path when turning a ContentSymbol back into a
 * WorkspaceSymbol for a specific query.
 */
export interface ContentSymbol {
	readonly name: string;
	readonly kind: string;
	readonly line: number;
	readonly character: number;
	readonly containerName?: string;
}

/**
 * One shared, content-addressed cache entry. May hold any subset of the
 * lenses derived from the same immutable content -- raw bytes, extracted
 * symbols, and (later) whatever else is derived from that content -- never
 * two independently-invalidated entries for the same hash.
 */
export interface ContentCacheEntry {
	readonly rawContent?: string;
	readonly symbols?: readonly ContentSymbol[];
}

/**
 * ContentCachePort -- the one store both the filesystem lens (raw text) and
 * the code-intelligence lens (parsed symbols) read and write, keyed by
 * ContentHash. Populated incrementally: whichever lens touches a hash first
 * creates the entry with just that lens present; a later put for the other
 * lens on the *same* hash adds to the existing entry rather than replacing
 * it -- this is what makes bidirectional warming possible by construction,
 * not by hand-wiring each pair of operations to know about each other.
 *
 * Content-addressed, so there is no invalidation method: a hash's entry
 * never becomes wrong (the content it was computed from cannot change
 * without producing a different hash). What can change is which hash a
 * *path* currently points to -- that mapping lives above this port, not in
 * it (see WorkspacePort).
 */
export interface ContentCachePort {
	get(hash: ContentHash): Promise<ContentCacheEntry | undefined>;
	putRawContent(hash: ContentHash, content: string): Promise<void>;
	putSymbols(hash: ContentHash, symbols: readonly ContentSymbol[]): Promise<void>;
}
