/** Raised when a caller-influenced search query could be interpreted as a ripgrep flag rather than a literal pattern. */
export class UnsafeSearchQuery extends Error {
	constructor(readonly value: string) {
		super(`"${value}" cannot be used as a search query -- it would be interpreted as a flag, not a literal pattern`);
		this.name = "UnsafeSearchQuery";
	}
}

/**
 * Rejects any value ripgrep's own argv parser could interpret as a flag rather than a literal
 * pattern -- the same root cause as git's own argv-injection class, applied to a different tool.
 * The adapter also passes `--` ahead of the query as defense in depth beyond this check, the
 * same two-layer approach already used for git's diff ref.
 */
export function assertSafeSearchQuery(value: string): void {
	if (value.startsWith("-")) throw new UnsafeSearchQuery(value);
}
