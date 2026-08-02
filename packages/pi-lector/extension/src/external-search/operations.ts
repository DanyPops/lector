import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeCandidate } from "@danypops/lector";
import { lectorClient } from "../lector-client.ts";

/** Thin wrapper over search.githubRepos/search.npmPackages/search.sourcegraphCode -- explicit-query discovery inputs shaped for repo_cache/package_source, never open-ended discovery/trending. */
export interface ExternalSearchOperations {
	githubRepos(query: string, maxResults: number): Promise<GithubRepoSearchResult>;
	npmPackages(query: string, maxResults: number): Promise<{ candidates: readonly NpmPackageCandidate[] }>;
	sourcegraphCode(query: string, maxResults: number): Promise<{ candidates: readonly SourcegraphCodeCandidate[] }>;
}

export function createExternalSearchOperations(): ExternalSearchOperations {
	return {
		async githubRepos(query, maxResults) {
			const client = await lectorClient();
			return client.call("search.githubRepos", { query, maxResults });
		},
		async npmPackages(query, maxResults) {
			const client = await lectorClient();
			return client.call("search.npmPackages", { query, maxResults });
		},
		async sourcegraphCode(query, maxResults) {
			const client = await lectorClient();
			return client.call("search.sourcegraphCode", { query, maxResults });
		},
	};
}
