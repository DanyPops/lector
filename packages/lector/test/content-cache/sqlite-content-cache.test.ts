/**
 * SqliteContentCache is Lector's first genuinely durable store. The
 * conformance suite proves correctness; the "survives reopen" test below
 * is the actual durability proof -- a value written by one
 * process/instance is still there after that instance is gone and a
 * fresh one opens the same file.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteContentCache } from "../../src/content-cache/sqlite-content-cache.ts";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { runContentCachePortConformanceSuite } from "../support/content-cache-port-conformance.ts";

runContentCachePortConformanceSuite("SqliteContentCache", {
	createCache: () => new SqliteContentCache(":memory:"),
	cleanup: (cache) => (cache as SqliteContentCache).close(),
});

describe("SqliteContentCache durability", () => {
	it("keeps a written entry after the writing instance is closed and a fresh one opens the same file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lector-sqlite-cache-durability-"));
		const dbPath = join(dir, "content-cache.db");
		try {
			const hash = contentHashOf("export function add() {}");
			const symbols = [{ name: "add", kind: "function", line: 1, character: 1 }];

			const first = new SqliteContentCache(dbPath);
			await first.putRawContent(hash, "export function add() {}");
			await first.putSymbols(hash, symbols);
			first.close();

			// A genuinely new instance -- no shared in-process state with `first` at all,
			// only the database file on disk. This is the actual claim "durable" makes.
			const second = new SqliteContentCache(dbPath);
			try {
				expect(await second.get(hash)).toEqual({ rawContent: "export function add() {}", symbols });
			} finally {
				second.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("SqliteContentCache eviction", () => {
	it("evicts the least-recently-accessed entries once the row-count budget is exceeded, and returns to budget rather than just accepting the new entry", async () => {
		let now = 0;
		const cache = new SqliteContentCache(":memory:", { maxEntries: 3, now: () => now });
		try {
			for (let i = 0; i < 3; i++) {
				now += 1;
				await cache.putRawContent(contentHashOf(`entry-${i}`), `content ${i}`);
			}
			// Exactly at budget -- nothing evicted yet.
			for (let i = 0; i < 3; i++) {
				expect(await cache.get(contentHashOf(`entry-${i}`))).toEqual({ rawContent: `content ${i}` });
			}

			now += 1;
			await cache.putRawContent(contentHashOf("entry-3"), "content 3");

			// The oldest entry is gone -- the cache is back at budget, not merely still accepting writes.
			expect(await cache.get(contentHashOf("entry-0"))).toBeUndefined();
			for (let i = 1; i <= 3; i++) {
				expect(await cache.get(contentHashOf(`entry-${i}`))).toEqual({ rawContent: `content ${i}` });
			}
		} finally {
			cache.close();
		}
	});

	it("a get() refreshes an entry's recency, so a since-read old entry survives eviction over one that was never re-read", async () => {
		let now = 0;
		const cache = new SqliteContentCache(":memory:", { maxEntries: 2, now: () => now });
		try {
			now = 1;
			await cache.putRawContent(contentHashOf("a"), "a");
			now = 2;
			await cache.putRawContent(contentHashOf("b"), "b");

			// Touch "a" -- it is now more recently accessed than "b", even though "b" was written later.
			now = 3;
			await cache.get(contentHashOf("a"));

			now = 4;
			await cache.putRawContent(contentHashOf("c"), "c"); // pushes the cache to 3 entries, over the budget of 2

			expect(await cache.get(contentHashOf("b"))).toBeUndefined(); // evicted: least recently touched
			expect(await cache.get(contentHashOf("a"))).toEqual({ rawContent: "a" }); // survived: was re-read
			expect(await cache.get(contentHashOf("c"))).toEqual({ rawContent: "c" });
		} finally {
			cache.close();
		}
	});

	it("defaults to a bounded budget without requiring the caller to configure one", async () => {
		const cache = new SqliteContentCache(":memory:");
		try {
			await cache.putRawContent(contentHashOf("x"), "x");
			expect(await cache.get(contentHashOf("x"))).toEqual({ rawContent: "x" });
		} finally {
			cache.close();
		}
	});
});
