import { describe, expect, it } from "bun:test";
import { InMemorySearchCache } from "../../src/search-cache/in-memory-search-cache.ts";
import { runSearchCachePortConformanceSuite } from "../support/search-cache-port-conformance.ts";

runSearchCachePortConformanceSuite("InMemorySearchCache", {
	createCache: () => new InMemorySearchCache(),
});

describe("InMemorySearchCache TTL", () => {
	it("expires an entry once ttlMs has elapsed, not just on process restart", async () => {
		const cache = new InMemorySearchCache({ ttlMs: 10 });
		const key = { workspaceId: "ws-1", query: "hello", maxMatches: 100, maxBytes: 1000 };
		await cache.set(key, { matches: [], truncated: false });
		expect(await cache.get(key)).toBeDefined();

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(await cache.get(key)).toBeUndefined();
	});

	it("evicts the least-recently-used entry once maxEntries is exceeded", async () => {
		const cache = new InMemorySearchCache({ maxEntries: 1 });
		const first = { workspaceId: "ws-1", query: "first", maxMatches: 100, maxBytes: 1000 };
		const second = { workspaceId: "ws-1", query: "second", maxMatches: 100, maxBytes: 1000 };
		await cache.set(first, { matches: [], truncated: false });
		await cache.set(second, { matches: [], truncated: false });

		expect(await cache.get(first)).toBeUndefined();
		expect(await cache.get(second)).toBeDefined();
	});
});
