/**
 * Shared conformance suite for any ContentCachePort implementation. Every
 * adapter (InMemoryContentCache, SqliteContentCache, and any future one)
 * must pass this unmodified. Covers the round-trip obligation (a value
 * stored under a hash must be retrieved under that same hash) and the
 * "one shared entry, not two stores kept in sync" property that is the
 * entire point of this port.
 */
import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/domain/content-hash.ts";
import type { ContentCachePort } from "../../src/ports/content-cache-port.ts";

export interface ContentCacheConformanceHarness {
	createCache(): ContentCachePort | Promise<ContentCachePort>;
	cleanup?(cache: ContentCachePort): void | Promise<void>;
}

export function runContentCachePortConformanceSuite(name: string, harness: ContentCacheConformanceHarness): void {
	async function withCache<T>(fn: (cache: ContentCachePort) => Promise<T>): Promise<T> {
		const cache = await harness.createCache();
		try {
			return await fn(cache);
		} finally {
			await harness.cleanup?.(cache);
		}
	}

	describe(`ContentCachePort conformance: ${name}`, () => {
		it("returns undefined for a hash nothing was ever stored under", () =>
			withCache(async (cache) => {
				expect(await cache.get(contentHashOf("never stored"))).toBeUndefined();
			}));

		it("round-trips raw content under the exact hash it was stored under", () =>
			withCache(async (cache) => {
				const hash = contentHashOf("hello");
				await cache.putRawContent(hash, "hello");
				expect(await cache.get(hash)).toEqual({ rawContent: "hello" });
			}));

		it("round-trips symbols under the exact hash they were stored under", () =>
			withCache(async (cache) => {
				const hash = contentHashOf("export function add() {}");
				const symbols = [{ name: "add", kind: "function", line: 1, character: 1 }];
				await cache.putSymbols(hash, symbols);
				expect(await cache.get(hash)).toEqual({ symbols });
			}));

		it("stores symbols with no path -- content-derived data must not carry which file currently holds it", () =>
			withCache(async (cache) => {
				const hash = contentHashOf("export function add() {}");
				await cache.putSymbols(hash, [{ name: "add", kind: "function", line: 1, character: 1 }]);
				const entry = await cache.get(hash);
				expect(entry?.symbols?.[0]).not.toHaveProperty("path");
				expect(entry?.symbols?.[0]).not.toHaveProperty("location");
			}));

		it("holds both lenses in one entry for the same hash -- not two stores kept in sync", () =>
			withCache(async (cache) => {
				const hash = contentHashOf("export function add() {}");
				const symbols = [{ name: "add", kind: "function", line: 1, character: 1 }];

				// Two independent writers (the fs lens, the code-intel lens) touching the same
				// hash -- neither one's write may erase the other's.
				await cache.putRawContent(hash, "export function add() {}");
				await cache.putSymbols(hash, symbols);

				expect(await cache.get(hash)).toEqual({ rawContent: "export function add() {}", symbols });
			}));

		it("does not let a write to one hash affect a different hash", () =>
			withCache(async (cache) => {
				const hashA = contentHashOf("content A");
				const hashB = contentHashOf("content B");
				await cache.putRawContent(hashA, "content A");
				await cache.putRawContent(hashB, "content B");

				expect(await cache.get(hashA)).toEqual({ rawContent: "content A" });
				expect(await cache.get(hashB)).toEqual({ rawContent: "content B" });
			}));

		it("overwriting one lens for a hash does not erase the other lens already recorded there", () =>
			withCache(async (cache) => {
				const hash = contentHashOf("export function add() {}");
				const symbols = [{ name: "add", kind: "function", line: 1, character: 1 }];
				await cache.putSymbols(hash, symbols);
				await cache.putRawContent(hash, "export function add() {}");
				// A second, later write to the rawContent lens alone (mechanically: whatever hash
				// the caller passes) must never touch the symbols lens already stored under that key.
				await cache.putRawContent(hash, "export function add() {} // updated raw content, same key");

				const entry = await cache.get(hash);
				expect(entry?.symbols).toEqual(symbols);
			}));
	});
}
