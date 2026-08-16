import type { CachedRepositoryPage } from "@danypops/lector";
import { invokeLectorVehicleOperation, type LectorVehicleCall } from "../vehicle-client.ts";

/** Matches REPO_LIST_CACHE_PERMISSIONS' own declared value server-side (repo-fetcher/operation-registration.ts). */
const REPO_LIST_CACHE_PERMISSIONS = ["workspace:read"];

/**
 * Thin wrapper over repo.listCache, dispatched through invokeVehicleOperation -- no network, no
 * cache mutation, no `directory`/workspaceForDirectory resolution (matching
 * repo-fetch/operations.ts: this queries the daemon-wide fetch cache, not a workspace-scoped
 * concept).
 */
export interface RepoCacheListOperations {
	list(
		filters: { text?: string; host?: string; owner?: string; repo?: string; ref?: string },
		maxResults: number,
		cursor: string | undefined,
		call: LectorVehicleCall,
	): Promise<CachedRepositoryPage>;
}

export function createRepoCacheListOperations(): RepoCacheListOperations {
	return {
		async list(filters, maxResults, cursor, call) {
			const result = await invokeLectorVehicleOperation("repo.listCache", { ...filters, maxResults, cursor }, REPO_LIST_CACHE_PERMISSIONS, call);
			return result.details.output as CachedRepositoryPage;
		},
	};
}
