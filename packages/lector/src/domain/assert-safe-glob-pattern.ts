/** Raised when a caller-influenced glob pattern could be interpreted as a ripgrep flag rather than a literal pattern. */
export class UnsafeGlobPattern extends Error {
	constructor(readonly value: string) {
		super(`"${value}" cannot be used as a glob pattern -- it would be interpreted as a flag, not a literal pattern`);
		this.name = "UnsafeGlobPattern";
	}
}

/**
 * Rejects any value ripgrep's own argv parser could interpret as a flag rather than a literal
 * glob -- the same root cause as assertSafeSearchQuery, applied to workspace.findFiles' pattern
 * argument instead of workspace.searchText's query argument. The adapter also passes `--` ahead
 * of every glob as defense in depth beyond this check, the same two-layer approach already used
 * for git's diff ref and for searchText's own query.
 */
export function assertSafeGlobPattern(value: string): void {
	if (value.startsWith("-")) throw new UnsafeGlobPattern(value);
}
