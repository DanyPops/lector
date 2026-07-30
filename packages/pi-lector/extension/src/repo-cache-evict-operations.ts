import { lectorClient } from "./lector-client.ts";

/**
 * Thin wrapper over repo.evictCache -- no `directory`/workspaceForDirectory resolution (matching
 * repo-fetch-operations.ts and repo-cache-list-operations.ts: this targets the daemon-wide fetch
 * cache, not a workspace-scoped concept).
 */
export interface RepoCacheEvictOperations {
	evict(host: string, owner: string, repo: string, ref: string | null): Promise<{ evicted: boolean }>;
}

export function createRepoCacheEvictOperations(): RepoCacheEvictOperations {
	return {
		async evict(host, owner, repo, ref) {
			const client = await lectorClient();
			return client.call("repo.evictCache", { host, owner, repo, ref });
		},
	};
}
