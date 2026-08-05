import { resolve } from "node:path";
import type { Logger } from "@danypops/vehicle-server/logging";
import { type CachedRepositoryEntry, queryCachedRepositories } from "../repo-fetcher/cached-repository-entry.ts";
import type { RepoFetcherPort } from "../repo-fetcher/port.ts";
import {
	deriveWorkspaceId,
	type MutableRegistry,
	type OperationInputs,
	type OperationOutputs,
	RepoCacheEntryInUse,
	RepoFetcherNotConfigured,
} from "../service.ts";
import { LocalFilesystemWorkspace } from "../workspace/local-filesystem-workspace.ts";
import { ReadOnlyWorkspace } from "../workspace/read-only-workspace.ts";

export interface RepoFetchHandlerDeps {
	readonly repoFetcher: RepoFetcherPort | undefined;
	readonly logger: Logger;
}

export interface RepoFetchHandlers {
	"repo.fetch": (registry: MutableRegistry, input: OperationInputs["repo.fetch"]) => Promise<OperationOutputs["repo.fetch"]>;
	"repo.listCache": (registry: MutableRegistry, input: OperationInputs["repo.listCache"]) => Promise<OperationOutputs["repo.listCache"]>;
	"repo.evictCache": (registry: MutableRegistry, input: OperationInputs["repo.evictCache"]) => Promise<OperationOutputs["repo.evictCache"]>;
}

/** repo.fetch/listCache/evictCache -- RepoFetcherPort's disk-cached external-repo checkouts, registered read-only into the same workspace registry every other operation reads from. */
export function createRepoFetchHandlers(deps: RepoFetchHandlerDeps): RepoFetchHandlers {
	return {
		/** Fetches (or reuses a cached clone of) an external repo and registers it read-only -- the same registry every other operation already reads from, so find_symbols/go_to_definition/git status etc. work on it unchanged once fetched. forceRefresh threads straight through to RepoFetcherPort's own existing policy -- the "update" verb; previously only reachable internally by the remote-change watcher, never by a caller. */
		async "repo.fetch"(registry, input) {
			if (!deps.repoFetcher) throw new RepoFetcherNotConfigured();
			const { forceRefresh, ...reference } = input;
			let result: Awaited<ReturnType<RepoFetcherPort["fetch"]>>;
			try {
				result = await deps.repoFetcher.fetch(reference, { forceRefresh });
			} catch (error: unknown) {
				deps.logger.warn("repository fetch failed", {
					component: "repo-fetch",
					operation: "repo.fetch",
					code: error instanceof Error ? error.name || "Error" : "Error",
				});
				throw error;
			}
			const absolutePath = resolve(result.path);
			const workspaceId = deriveWorkspaceId(absolutePath);
			if (!registry.has(workspaceId)) {
				registry.set(workspaceId, {
					port: new ReadOnlyWorkspace(new LocalFilesystemWorkspace(absolutePath)),
					rootPath: absolutePath,
					origin: "remote",
					remoteReference: reference,
				});
			}
			deps.logger.info("repository fetch completed", {
				component: "repo-fetch",
				operation: "repo.fetch",
				fromCache: result.fromCache,
			});
			return { workspaceId, ...result };
		},
		async "repo.listCache"(registry, input) {
			if (!deps.repoFetcher) throw new RepoFetcherNotConfigured();
			const raw = await deps.repoFetcher.listCached();
			const entries: CachedRepositoryEntry[] = raw.map((entry) => {
				const workspaceId = deriveWorkspaceId(resolve(entry.path));
				return { ...entry, registeredWorkspaceId: registry.has(workspaceId) ? workspaceId : null };
			});
			const { host, owner, repo, ref, text } = input;
			return queryCachedRepositories(entries, { host, owner, repo, ref, text }, input.maxResults, input.cursor);
		},
		/** Refuses (RepoCacheEntryInUse) rather than deleting a currently-registered workspace's backing checkout out from under it -- there is no workspace.unregister operation to resolve that conflict safely today. */
		async "repo.evictCache"(registry, input) {
			if (!deps.repoFetcher) throw new RepoFetcherNotConfigured();
			const requestedRef = input.ref ?? "HEAD";
			const cached = (await deps.repoFetcher.listCached()).find(
				(entry) => entry.host === input.host && entry.owner === input.owner && entry.repo === input.repo && entry.requestedRef === requestedRef,
			);
			if (cached) {
				const workspaceId = deriveWorkspaceId(resolve(cached.path));
				if (registry.has(workspaceId)) {
					deps.logger.warn("repository cache eviction rejected", {
						component: "repo-fetch",
						operation: "repo.evictCache",
						code: "RepoCacheEntryInUse",
					});
					throw new RepoCacheEntryInUse(workspaceId);
				}
			}
			const evicted = await deps.repoFetcher.evict(input);
			deps.logger.info("repository cache eviction completed", { component: "repo-fetch", operation: "repo.evictCache", evicted });
			return { evicted };
		},
	};
}
