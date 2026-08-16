import type { RepoFetchResult } from "@danypops/lector";
import { invokeLectorVehicleOperation, type LectorVehicleCall } from "../vehicle-client.ts";

/** Matches REPO_WRITE_PERMISSIONS' own declared value server-side (repo-fetcher/operation-registration.ts). */
const REPO_WRITE_PERMISSIONS = ["workspace:write"];

/**
 * Thin wrapper over repo.fetch, dispatched through invokeVehicleOperation (the real
 * VehicleRegistry-backed operation -- see Lector's vehicle-client-pi adoption epic) instead of a
 * bare lectorClient().call(). No `directory`/workspaceForDirectory resolution here -- unlike
 * every other tool in this extension, this one doesn't target an existing local directory, it
 * creates a new registered workspace from a fetched external repo.
 */
export interface RepoFetchOperations {
	fetch(
		host: string,
		owner: string,
		repo: string,
		ref: string | null,
		forceRefresh: boolean | undefined,
		call: LectorVehicleCall,
	): Promise<RepoFetchResult & { workspaceId: string }>;
}

export function createLectorRepoFetchOperations(): RepoFetchOperations {
	return {
		async fetch(host, owner, repo, ref, forceRefresh, call) {
			const result = await invokeLectorVehicleOperation("repo.fetch", { host, owner, repo, ref, forceRefresh }, REPO_WRITE_PERMISSIONS, call);
			return result.details.output as RepoFetchResult & { workspaceId: string };
		},
	};
}
