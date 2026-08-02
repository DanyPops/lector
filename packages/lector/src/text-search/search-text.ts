import { assertSafeSearchQuery } from "../domain/assert-safe-search-query.ts";
import type { SearchCachePort } from "../search-cache/port.ts";
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
	if (cache) await cache.set(key, result);
	return result;
}
