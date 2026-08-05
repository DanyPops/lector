import type { ExternalSearchBounds, GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeCandidate } from "../external-search/external-search-result.ts";
import type { ExternalSearchCachePort } from "../external-search-cache/port.ts";
import type { GithubSearchPort } from "../github-search/port.ts";
import type { NpmRegistryPort } from "../npm-registry/port.ts";
import type { MutableRegistry, OperationInputs, OperationOutputs } from "../service.ts";
import type { SourcegraphSearchPort } from "../sourcegraph-search/port.ts";

/** Fixed, not caller-configurable -- matches workspace.searchText's own precedent of exposing only the caller-relevant bound (maxResults/maxMatches) at the operation level and keeping transport-level bounds (timeout, response size, retries) as internal service policy. */
const MAX_EXTERNAL_SEARCH_RESULTS = 100;
const EXTERNAL_SEARCH_BOUNDS = { timeoutMs: 10_000, maxResponseBytes: 8 * 1024 * 1024, maxRetries: 2 } as const;

function externalSearchBounds(maxResults: number): ExternalSearchBounds {
	if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_EXTERNAL_SEARCH_RESULTS) {
		throw new TypeError(`maxResults must be a positive safe integer no greater than ${MAX_EXTERNAL_SEARCH_RESULTS}`);
	}
	return { maxResults, ...EXTERNAL_SEARCH_BOUNDS };
}

export interface ExternalSearchHandlerDeps {
	readonly githubSearch: GithubSearchPort;
	readonly npmRegistry: NpmRegistryPort;
	readonly sourcegraphSearch: SourcegraphSearchPort;
	readonly githubSearchCache: ExternalSearchCachePort<GithubRepoSearchResult>;
	readonly npmSearchCache: ExternalSearchCachePort<{ candidates: readonly NpmPackageCandidate[] }>;
	readonly sourcegraphSearchCache: ExternalSearchCachePort<{ candidates: readonly SourcegraphCodeCandidate[] }>;
}

export interface ExternalSearchHandlers {
	"search.githubRepos": (registry: MutableRegistry, input: OperationInputs["search.githubRepos"]) => Promise<OperationOutputs["search.githubRepos"]>;
	"search.npmPackages": (registry: MutableRegistry, input: OperationInputs["search.npmPackages"]) => Promise<OperationOutputs["search.npmPackages"]>;
	"search.sourcegraphCode": (
		registry: MutableRegistry,
		input: OperationInputs["search.sourcegraphCode"],
	) => Promise<OperationOutputs["search.sourcegraphCode"]>;
}

/** search.githubRepos/npmPackages/sourcegraphCode -- each source's own short-TTL result cache, keyed by query+maxResults. No workspace/registry dependency at all. */
export function createExternalSearchHandlers(deps: ExternalSearchHandlerDeps): ExternalSearchHandlers {
	return {
		async "search.githubRepos"(_registry, input) {
			const bounds = externalSearchBounds(input.maxResults);
			const cacheKey = { source: "github-repos" as const, query: input.query, maxResults: input.maxResults };
			const cached = await deps.githubSearchCache.get(cacheKey);
			if (cached) return cached;
			const result = await deps.githubSearch.searchRepos(input.query, bounds);
			await deps.githubSearchCache.set(cacheKey, result);
			return result;
		},
		async "search.npmPackages"(_registry, input) {
			const bounds = externalSearchBounds(input.maxResults);
			const cacheKey = { source: "npm-packages" as const, query: input.query, maxResults: input.maxResults };
			const cached = await deps.npmSearchCache.get(cacheKey);
			if (cached) return cached;
			const candidates = await deps.npmRegistry.search(input.query, bounds);
			const result = { candidates };
			await deps.npmSearchCache.set(cacheKey, result);
			return result;
		},
		async "search.sourcegraphCode"(_registry, input) {
			const bounds = externalSearchBounds(input.maxResults);
			const cacheKey = { source: "sourcegraph-code" as const, query: input.query, maxResults: input.maxResults };
			const cached = await deps.sourcegraphSearchCache.get(cacheKey);
			if (cached) return cached;
			const candidates = await deps.sourcegraphSearch.searchCode(input.query, bounds);
			const result = { candidates };
			await deps.sourcegraphSearchCache.set(cacheKey, result);
			return result;
		},
	};
}
