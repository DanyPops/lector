import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySearchCache } from "../../src/adapters/in-memory-search-cache.ts";
import { SqliteSearchCache } from "../../src/adapters/sqlite-search-cache.ts";
import { TieredSearchCache } from "../../src/adapters/tiered-search-cache.ts";
import { runSearchCachePortConformanceSuite } from "../support/search-cache-port-conformance.ts";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function build(): TieredSearchCache {
	dir = mkdtempSync(join(tmpdir(), "lector-tiered-search-cache-"));
	return new TieredSearchCache(new InMemorySearchCache(), new SqliteSearchCache(join(dir, "search-cache.db")));
}

runSearchCachePortConformanceSuite("TieredSearchCache", { createCache: () => build() });

describe("TieredSearchCache", () => {
	it("a hit served from the durable tier warms the fast tier, so a third read never touches disk again", async () => {
		dir = mkdtempSync(join(tmpdir(), "lector-tiered-search-cache-"));
		const fast = new InMemorySearchCache();
		const durable = new SqliteSearchCache(join(dir, "search-cache.db"));
		const tiered = new TieredSearchCache(fast, durable);

		const key = { workspaceId: "ws-1", query: "hello", maxMatches: 100, maxBytes: 1000 };
		const result = { matches: [{ path: "a.txt", lineNumber: 1, line: "hello", matchStart: 0, matchEnd: 5 }], truncated: false };

		// Written to durable only -- simulates a value that survived a restart wiping the
		// in-memory tier but not the disk-backed one.
		await durable.set(key, result);
		expect(await fast.get(key)).toBeUndefined();

		const first = await tiered.get(key);
		expect(first).toEqual(result);
		expect(await fast.get(key)).toEqual(result);
	});

	it("writes land in both tiers, not just the fast one", async () => {
		dir = mkdtempSync(join(tmpdir(), "lector-tiered-search-cache-"));
		const fast = new InMemorySearchCache();
		const durable = new SqliteSearchCache(join(dir, "search-cache.db"));
		const tiered = new TieredSearchCache(fast, durable);

		const key = { workspaceId: "ws-1", query: "hello", maxMatches: 100, maxBytes: 1000 };
		const result = { matches: [], truncated: false };
		await tiered.set(key, result);

		expect(await fast.get(key)).toEqual(result);
		expect(await durable.get(key)).toEqual(result);
	});
});
