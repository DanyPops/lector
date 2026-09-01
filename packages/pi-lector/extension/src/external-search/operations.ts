import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeSearchResult } from "@danypops/lector";
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
	sourcegraphCode(query: string, maxResults: number, call: LectorVehicleCall): Promise<SourcegraphCodeSearchResult>;
}

export function createExternalSearchOperations(): ExternalSearchOperations {
	return {
		githubRepos(query, maxResults, call) {
			return invokeLectorVehicleOperation<GithubRepoSearchResult>("search.githubRepos", { query, maxResults }, EXTERNAL_SEARCH_PERMISSIONS, call);
		},
		npmPackages(query, maxResults, call) {
			return invokeLectorVehicleOperation<{ candidates: readonly NpmPackageCandidate[] }>(
				"search.npmPackages",
				{ query, maxResults },
				EXTERNAL_SEARCH_PERMISSIONS,
				call,
			);
		},
		sourcegraphCode(query, maxResults, call) {
			return invokeLectorVehicleOperation<SourcegraphCodeSearchResult>("search.sourcegraphCode", { query, maxResults }, EXTERNAL_SEARCH_PERMISSIONS, call);
		},
	};
}
