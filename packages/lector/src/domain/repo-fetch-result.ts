/** Result of ensuring a shallow clone exists for a RepoReference. */
export interface RepoFetchResult {
	readonly path: string;
	readonly fromCache: boolean;
	/** The ref actually checked out -- may differ from the requested ref if it didn't exist and cloning fell back to the default branch. */
	readonly resolvedRef: string;
	readonly refFallbackOccurred: boolean;
}

/** Raised when neither the requested ref nor a default-branch fallback could be cloned. */
export class RepoFetchFailed extends Error {
	constructor(host: string, owner: string, repo: string, ref: string | null, cause: unknown) {
		const target = `${host}/${owner}/${repo}${ref ? `@${ref}` : ""}`;
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`failed to fetch ${target}: ${reason}`);
		this.name = "RepoFetchFailed";
	}
}
