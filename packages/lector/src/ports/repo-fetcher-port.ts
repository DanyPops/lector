import type { RepoFetchPolicy, RepoFetchResult } from "../domain/repo-fetch-result.ts";
import type { RepoReference } from "../domain/repo-reference.ts";

/**
 * RepoFetcherPort -- ensures a shallow local clone of an external repo exists, content-addressed
 * by (host, owner, repo, ref). A caller never mutates a returned checkout; it's a foreign
 * directory to read and analyze, not one the caller owns.
 */
export interface RepoFetcherPort {
	fetch(reference: RepoReference, policy?: RepoFetchPolicy): Promise<RepoFetchResult>;
}
