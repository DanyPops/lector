/** A caller-supplied Git revision that does not resolve in the selected repository. */
export class GitRevisionNotFound extends Error {
	constructor(readonly revision: string) {
		super(`Git revision "${revision}" does not exist`);
		this.name = "GitRevisionNotFound";
	}
}

export function gitErrorIsMissingRevision(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	// "invalid reference" is git worktree add's own wording for the identical condition
	// (bad-revision/showFile/diff instead use "bad revision"/"unknown revision"/etc).
	return /(?:bad revision|unknown revision|invalid object name|ambiguous argument|not a valid object name|invalid reference)/i.test(error.message);
}
