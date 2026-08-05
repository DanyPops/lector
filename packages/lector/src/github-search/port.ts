import type { ExternalSearchBounds, GithubRepoSearchResult } from "../external-search/external-search-result.ts";

export interface GithubSearchPort {
	searchRepos(query: string, bounds: ExternalSearchBounds): Promise<GithubRepoSearchResult>;
}
