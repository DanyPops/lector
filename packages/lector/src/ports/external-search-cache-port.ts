import type { ExternalSearchCacheKey } from "../domain/external-search-cache-key.ts";

/** Short-TTL cache for one external-search source's results -- keyed by query+maxResults, not content-addressed (search results are time-sensitive, unlike ContentCachePort's "never invalidates" contract) and not TextSearchResult-shaped (unlike SearchCachePort). Each source gets its own instance/value type. */
export interface ExternalSearchCachePort<T> {
	get(key: ExternalSearchCacheKey): Promise<T | undefined>;
	set(key: ExternalSearchCacheKey, value: T): Promise<void>;
}
