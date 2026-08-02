import type { TextSearchResult } from "../domain/text-search-result.ts";
import type { SearchCacheKey } from "./search-cache-key.ts";

/**
 * SearchCachePort -- caches searchText results by (workspaceId, query, options), a genuinely
 * different shape from ContentCachePort's per-content-hash keying: a search result isn't
 * derived from one file's content, it's derived from a query run against a whole workspace at
 * a point in time, so it needs its own TTL rather than ContentCachePort's "never invalidates"
 * contract (which only holds because content-addressing makes invalidation structurally
 * impossible to need -- that reasoning doesn't apply here).
 */
export interface SearchCachePort {
	get(key: SearchCacheKey): Promise<TextSearchResult | undefined>;
	set(key: SearchCacheKey, result: TextSearchResult): Promise<void>;
}
