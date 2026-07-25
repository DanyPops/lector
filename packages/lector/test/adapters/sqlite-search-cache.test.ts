import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSearchCache } from "../../src/adapters/sqlite-search-cache.ts";
import { runSearchCachePortConformanceSuite } from "../support/search-cache-port-conformance.ts";

let dir: string | undefined;

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function dbPath(): string {
	dir = mkdtempSync(join(tmpdir(), "lector-search-cache-"));
	return join(dir, "search-cache.db");
}

runSearchCachePortConformanceSuite("SqliteSearchCache", {
	createCache: () => new SqliteSearchCache(dbPath()),
});

describe("SqliteSearchCache", () => {
	it("expires an entry once ttlMs has elapsed", async () => {
		const cache = new SqliteSearchCache(dbPath(), { ttlMs: 10 });
		const key = { workspaceId: "ws-1", query: "hello", maxMatches: 100, maxBytes: 1000 };
		await cache.set(key, { matches: [], truncated: false });
		expect(await cache.get(key)).toBeDefined();

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(await cache.get(key)).toBeUndefined();
	});

	it("persists across a fresh instance pointed at the same database file -- a real restart, not just a new in-process object", async () => {
		const path = dbPath();
		const key = { workspaceId: "ws-1", query: "hello", maxMatches: 100, maxBytes: 1000 };
		const first = new SqliteSearchCache(path);
		await first.set(key, { matches: [{ path: "a.txt", lineNumber: 1, line: "hello", matchStart: 0, matchEnd: 5 }], truncated: false });
		first.close();

		const second = new SqliteSearchCache(path);
		const result = await second.get(key);
		second.close();

		expect(result?.matches.length).toBe(1);
	});
});
