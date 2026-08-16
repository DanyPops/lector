import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeCandidate } from "@danypops/lector";
import { invokeLectorVehicleOperation, type LectorVehicleCall } from "../vehicle-client.ts";

/** Matches EXTERNAL_SEARCH_PERMISSIONS' own declared value server-side (external-search/operation-registration.ts). */
const EXTERNAL_SEARCH_PERMISSIONS = ["external-search:read"];

/**
 * Thin wrapper over search.githubRepos/search.npmPackages/search.sourcegraphCode, dispatched
 * through invokeVehicleOperation -- explicit-query discovery inputs shaped for
 * repo_cache/package_source, never open-ended discovery/trending.
 */
export interface ExternalSearchOperations {
	githubRepos(query: string, maxResults: number, call: LectorVehicleCall): Promise<GithubRepoSearchResult>;
	npmPackages(query: string, maxResults: number, call: LectorVehicleCall): Promise<{ candidates: readonly NpmPackageCandidate[] }>;
	sourcegraphCode(query: string, maxResults: number, call: LectorVehicleCall): Promise<{ candidates: readonly SourcegraphCodeCandidate[] }>;
}

export function createExternalSearchOperations(): ExternalSearchOperations {
	return {
		async githubRepos(query, maxResults, call) {
			const result = await invokeLectorVehicleOperation("search.githubRepos", { query, maxResults }, EXTERNAL_SEARCH_PERMISSIONS, call);
			return result.details.output as GithubRepoSearchResult;
		},
		async npmPackages(query, maxResults, call) {
			const result = await invokeLectorVehicleOperation("search.npmPackages", { query, maxResults }, EXTERNAL_SEARCH_PERMISSIONS, call);
			return result.details.output as { candidates: readonly NpmPackageCandidate[] };
		},
		async sourcegraphCode(query, maxResults, call) {
			const result = await invokeLectorVehicleOperation("search.sourcegraphCode", { query, maxResults }, EXTERNAL_SEARCH_PERMISSIONS, call);
			return result.details.output as { candidates: readonly SourcegraphCodeCandidate[] };
		},
	};
}
