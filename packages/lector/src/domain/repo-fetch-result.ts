/** Result of ensuring a shallow clone exists for a RepoReference. */
export interface RepoFetchResult {
	readonly path: string;
	readonly fromCache: boolean;
	/** The ref actually checked out -- may differ from the requested ref if it didn't exist and cloning fell back to the default branch. */
	readonly resolvedRef: string;
	readonly refFallbackOccurred: boolean;
	readonly commit: string;
}

export interface RepoFetchPolicy {
	readonly exactRef?: boolean;
	readonly maxCloneBytes?: number;
	readonly maxCacheBytes?: number;
	readonly timeoutMs?: number;
}

export class RepoFetchCapacityExceeded extends Error {
	readonly maxQueued: number;

	constructor(maxQueued: number) {
		super(`repository fetch queue is full (${maxQueued} queued)`);
		this.name = "RepoFetchCapacityExceeded";
		this.maxQueued = maxQueued;
	}
}

export class RepoFetchLimitExceeded extends Error {
	readonly resource: "clone-bytes" | "cache-bytes";
	readonly limit: number;
	readonly observed: number;

	constructor(resource: RepoFetchLimitExceeded["resource"], limit: number, observed: number) {
		super(`repository ${resource} ${observed} exceeded limit ${limit}`);
		this.name = "RepoFetchLimitExceeded";
		this.resource = resource;
		this.limit = limit;
		this.observed = observed;
	}
}

/** Raised when the requested ref cannot be cloned under the caller's fallback policy. */
export class RepoFetchFailed extends Error {
	constructor(host: string, owner: string, repo: string, ref: string | null, cause: unknown) {
		const target = `${host}/${owner}/${repo}${ref ? `@${ref}` : ""}`;
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`failed to fetch ${target}: ${reason}`);
		this.name = "RepoFetchFailed";
	}
}
