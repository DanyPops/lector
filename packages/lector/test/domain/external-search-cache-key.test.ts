import { describe, expect, it } from "bun:test";
import { deriveExternalSearchCacheKey } from "../../src/domain/external-search-cache-key.ts";

describe("deriveExternalSearchCacheKey", () => {
	it("distinguishes source, query, and maxResults", () => {
		const base = deriveExternalSearchCacheKey({ source: "github-repos", query: "widgets", maxResults: 20 });
		expect(deriveExternalSearchCacheKey({ source: "npm-packages", query: "widgets", maxResults: 20 })).not.toBe(base);
		expect(deriveExternalSearchCacheKey({ source: "github-repos", query: "gadgets", maxResults: 20 })).not.toBe(base);
		expect(deriveExternalSearchCacheKey({ source: "github-repos", query: "widgets", maxResults: 10 })).not.toBe(base);
	});

	it("is stable for identical inputs", () => {
		const a = deriveExternalSearchCacheKey({ source: "sourcegraph-code", query: "foo", maxResults: 5 });
		const b = deriveExternalSearchCacheKey({ source: "sourcegraph-code", query: "foo", maxResults: 5 });
		expect(a).toBe(b);
	});
});
