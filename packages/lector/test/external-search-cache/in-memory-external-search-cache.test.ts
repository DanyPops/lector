import { describe, expect, it } from "bun:test";
import { InMemoryExternalSearchCache } from "../../src/external-search-cache/in-memory-external-search-cache.ts";

describe("InMemoryExternalSearchCache", () => {
	it("returns undefined for a key that was never set", async () => {
		const cache = new InMemoryExternalSearchCache<readonly string[]>();
		expect(await cache.get({ source: "npm-packages", query: "widgets", maxResults: 20 })).toBeUndefined();
	});

	it("returns a previously-set value for the identical key", async () => {
		const cache = new InMemoryExternalSearchCache<readonly string[]>();
		const key = { source: "github-repos" as const, query: "widgets", maxResults: 20 };
		await cache.set(key, ["acme/widgets"]);
		expect(await cache.get(key)).toEqual(["acme/widgets"]);
	});

	it("treats a different maxResults as a distinct cache entry", async () => {
		const cache = new InMemoryExternalSearchCache<readonly string[]>();
		await cache.set({ source: "github-repos", query: "widgets", maxResults: 20 }, ["a"]);
		expect(await cache.get({ source: "github-repos", query: "widgets", maxResults: 10 })).toBeUndefined();
	});

	it("expires an entry once ttlMs has elapsed", async () => {
		const cache = new InMemoryExternalSearchCache<readonly string[]>({ ttlMs: 10 });
		const key = { source: "sourcegraph-code" as const, query: "widgets", maxResults: 20 };
		await cache.set(key, ["a"]);
		expect(await cache.get(key)).toBeDefined();

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(await cache.get(key)).toBeUndefined();
	});

	it("evicts the least-recently-used entry once maxEntries is exceeded", async () => {
		const cache = new InMemoryExternalSearchCache<readonly string[]>({ maxEntries: 1 });
		const first = { source: "npm-packages" as const, query: "first", maxResults: 20 };
		const second = { source: "npm-packages" as const, query: "second", maxResults: 20 };
		await cache.set(first, ["a"]);
		await cache.set(second, ["b"]);

		expect(await cache.get(first)).toBeUndefined();
		expect(await cache.get(second)).toBeDefined();
	});
});
