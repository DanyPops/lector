export type ExternalSearchSource = "github-repos" | "npm-packages" | "sourcegraph-code";

/** Identifies one cached external-search result -- not code, not a workspace text match, so neither ContentCachePort's content-addressed shape nor SearchCachePort's own TextSearchResult type apply; this follows the same short-TTL pattern with its own key. */
export interface ExternalSearchCacheKey {
	readonly source: ExternalSearchSource;
	readonly query: string;
	readonly maxResults: number;
}

const KEY_SEPARATOR = "\u0000";

export function deriveExternalSearchCacheKey(key: ExternalSearchCacheKey): string {
	return `${key.source}${KEY_SEPARATOR}${key.query}${KEY_SEPARATOR}${key.maxResults}`;
}
