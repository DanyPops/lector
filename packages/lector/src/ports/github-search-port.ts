import type { ExternalSearchBounds, GithubRepoSearchResult } from "../domain/external-search-result.ts";

export interface GithubSearchPort {
	searchRepos(query: string, bounds: ExternalSearchBounds): Promise<GithubRepoSearchResult>;
}
