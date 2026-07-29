import type { RepoCacheListEntry } from "../domain/cached-repository-entry.ts";
import type { RepoFetchPolicy, RepoFetchResult } from "../domain/repo-fetch-result.ts";
import type { RepoReference } from "../domain/repo-reference.ts";

/**
 * RepoFetcherPort -- ensures a shallow local clone of an external repo exists, content-addressed
 * by (host, owner, repo, ref). A caller never mutates a returned checkout; it's a foreign
 * directory to read and analyze, not one the caller owns.
 */
export interface RepoFetcherPort {
	fetch(reference: RepoReference, policy?: RepoFetchPolicy): Promise<RepoFetchResult>;
	/**
	 * The commit a reference's tracked ref currently resolves to on the remote, without cloning
	 * or mutating anything -- undefined when it can't be determined (network failure, the ref
	 * doesn't name a moving branch/tag, e.g. it's already an exact commit sha). Undefined is a
	 * genuine "couldn't tell," never treated as evidence of staleness by a caller.
	 */
	resolveRemoteCommit(reference: RepoReference, timeoutMs?: number): Promise<string | undefined>;
	/** Every repository currently present in the cache, exactly as fetched -- no network call, no mutation of cache state (including LRU recency). */
	listCached(): Promise<readonly RepoCacheListEntry[]>;
}
