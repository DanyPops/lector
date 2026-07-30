import type { RepoFetchResult } from "@danypops/lector";
import { lectorClient } from "./lector-client.ts";

/**
 * Thin wrapper over repo.fetch. No `directory`/workspaceForDirectory resolution here -- unlike
 * every other tool in this extension, this one doesn't target an existing local directory, it
 * creates a new registered workspace from a fetched external repo.
 */
export interface RepoFetchOperations {
	fetch(host: string, owner: string, repo: string, ref: string | null, forceRefresh?: boolean): Promise<RepoFetchResult & { workspaceId: string }>;
}

export function createLectorRepoFetchOperations(): RepoFetchOperations {
	return {
		async fetch(host, owner, repo, ref, forceRefresh) {
			const client = await lectorClient();
			return client.call("repo.fetch", { host, owner, repo, ref, forceRefresh });
		},
	};
}
