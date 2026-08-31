import type { SearchCachePort } from "../search-cache/port.ts";
import { assertSafeSearchQuery } from "./assert-safe-search-query.ts";
import type { TextSearchOptions, TextSearchPort } from "./port.ts";
import type { TextSearchResult } from "./text-search-result.ts";

/**
 * Check-then-populate cache orchestration, kept as pure domain logic (not duplicated inside
 * every adapter, not left for service.ts to reimplement) -- the same shape as rawRead/exactEdit
 * being pure functions over a port. `cache` is optional: a caller with no cache configured still
 * gets a correct (just uncached) search.
 */
export async function searchText(
	textSearch: TextSearchPort,
	cache: SearchCachePort | undefined,
	rootPath: string,
	workspaceId: string,
	query: string,
	options: TextSearchOptions,
): Promise<TextSearchResult> {
	assertSafeSearchQuery(query);
	const key = { workspaceId, query, maxMatches: options.maxMatches, maxBytes: options.maxBytes };
	if (cache) {
		const cached = await cache.get(key);
		if (cached) return cached;
	}
	const result = await textSearch.search(rootPath, query, options);
	// Loading/stale/degraded fallbacks are fresh and correct, but caching them would pin the same
	// query to ripgrep after the durable index becomes ready. Cache stable adapter results only.
	if (cache && (!result.provenance || result.provenance.indexState === "ready")) await cache.set(key, result);
	return result;
}
