import { invokeLectorVehicleOperation, type LectorVehicleCall } from "../vehicle-client.ts";

/** Matches REPO_WRITE_PERMISSIONS' own declared value server-side (repo-fetcher/operation-registration.ts). */
const REPO_WRITE_PERMISSIONS = ["workspace:write"];

/**
 * Thin wrapper over repo.evictCache, dispatched through invokeVehicleOperation -- no
 * `directory`/workspaceForDirectory resolution (matching repo-fetch/operations.ts and
 * repo-cache/list-operations.ts: this targets the daemon-wide fetch cache, not a
 * workspace-scoped concept).
 */
export interface RepoCacheEvictOperations {
	evict(host: string, owner: string, repo: string, ref: string | null, call: LectorVehicleCall): Promise<{ evicted: boolean }>;
}

export function createRepoCacheEvictOperations(): RepoCacheEvictOperations {
	return {
		async evict(host, owner, repo, ref, call) {
			const result = await invokeLectorVehicleOperation("repo.evictCache", { host, owner, repo, ref }, REPO_WRITE_PERMISSIONS, call);
			return result.details.output as { evicted: boolean };
		},
	};
}
