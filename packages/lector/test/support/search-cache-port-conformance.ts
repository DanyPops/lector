/**
 * Shared conformance suite for any SearchCachePort implementation. Every adapter
 * (InMemorySearchCache, SqliteSearchCache, and any future one) must pass this unmodified.
 */
import { describe, expect, it } from "bun:test";
import type { TextSearchResult } from "../../src/domain/text-search-result.ts";
import type { SearchCachePort } from "../../src/search-cache/port.ts";
import type { SearchCacheKey } from "../../src/search-cache/search-cache-key.ts";

export interface SearchCacheConformanceHarness {
	createCache(): SearchCachePort | Promise<SearchCachePort>;
	cleanup?(cache: SearchCachePort): void | Promise<void>;
}

function key(overrides: Partial<SearchCacheKey> = {}): SearchCacheKey {
	return { workspaceId: "ws-1", query: "hello", maxMatches: 100, maxBytes: 10_000, ...overrides };
}

const RESULT: TextSearchResult = { matches: [{ path: "a.txt", lineNumber: 1, line: "hello world", matchStart: 0, matchEnd: 5 }], truncated: false };

export function runSearchCachePortConformanceSuite(name: string, harness: SearchCacheConformanceHarness): void {
	async function withCache<T>(fn: (cache: SearchCachePort) => Promise<T>): Promise<T> {
		const cache = await harness.createCache();
		try {
			return await fn(cache);
		} finally {
			await harness.cleanup?.(cache);
		}
	}

	describe(`SearchCachePort conformance: ${name}`, () => {
		it("returns undefined for a key nothing was ever stored under", () =>
			withCache(async (cache) => {
				expect(await cache.get(key())).toBeUndefined();
			}));

		it("round-trips a result under the exact key it was stored under", () =>
			withCache(async (cache) => {
				await cache.set(key(), RESULT);
				expect(await cache.get(key())).toEqual(RESULT);
			}));

		it("keeps a different query's cache entry independent, even for the same workspace", () =>
			withCache(async (cache) => {
				await cache.set(key({ query: "foo" }), RESULT);
				expect(await cache.get(key({ query: "bar" }))).toBeUndefined();
			}));

		it("keeps a different workspace's cache entry independent, even for the same query", () =>
			withCache(async (cache) => {
				await cache.set(key({ workspaceId: "ws-1" }), RESULT);
				expect(await cache.get(key({ workspaceId: "ws-2" }))).toBeUndefined();
			}));

		it("keeps entries under different bounds (maxMatches/maxBytes) independent -- a truncated search must never serve a differently-bounded caller's cached result", () =>
			withCache(async (cache) => {
				await cache.set(key({ maxMatches: 10 }), { matches: [], truncated: true });
				expect(await cache.get(key({ maxMatches: 1000 }))).toBeUndefined();
			}));

		it("a second set for the same key overwrites the first, rather than erroring or ignoring it", () =>
			withCache(async (cache) => {
				await cache.set(key(), RESULT);
				const updated: TextSearchResult = { matches: [], truncated: false };
				await cache.set(key(), updated);
				expect(await cache.get(key())).toEqual(updated);
			}));
	});
}
