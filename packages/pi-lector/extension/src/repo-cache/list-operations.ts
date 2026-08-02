import type { CachedRepositoryPage } from "@danypops/lector";
import { lectorClient } from "../lector-client.ts";

/**
 * Thin wrapper over repo.listCache -- no network, no cache mutation, no `directory`/
 * workspaceForDirectory resolution (matching repo-fetch/operations.ts: this queries the
 * daemon-wide fetch cache, not a workspace-scoped concept).
 */
export interface RepoCacheListOperations {
	list(
		filters: { text?: string; host?: string; owner?: string; repo?: string; ref?: string },
		maxResults: number,
		cursor?: string,
	): Promise<CachedRepositoryPage>;
}

export function createRepoCacheListOperations(): RepoCacheListOperations {
	return {
		async list(filters, maxResults, cursor) {
			const client = await lectorClient();
			return client.call("repo.listCache", { ...filters, maxResults, cursor });
		},
	};
}
