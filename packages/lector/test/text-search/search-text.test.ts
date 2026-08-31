/**
 * searchText's check-then-populate orchestration, against a real RipgrepTextSearch and a real
 * InMemorySearchCache -- the counting wrapper below only counts calls and forwards them to the
 * real adapter, it never fakes a result.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySearchCache } from "../../src/search-cache/in-memory-search-cache.ts";
import { UnsafeSearchQuery } from "../../src/text-search/assert-safe-search-query.ts";
import type { FindFilesOptions, TextSearchOptions, TextSearchPort } from "../../src/text-search/port.ts";
import { RipgrepTextSearch } from "../../src/text-search/ripgrep-text-search.ts";
import { searchText } from "../../src/text-search/search-text.ts";

class CountingTextSearch implements TextSearchPort {
	calls = 0;
	constructor(private readonly inner: TextSearchPort) {}
	search(rootPath: string, query: string, options: TextSearchOptions) {
		this.calls++;
		return this.inner.search(rootPath, query, options);
	}
	findFiles(rootPath: string, patterns: readonly string[], options: FindFilesOptions) {
		return this.inner.findFiles(rootPath, patterns, options);
	}
}

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-search-text-fixture-"));
	writeFileSync(join(root, "a.txt"), "hello world\n");
	return root;
}

describe("searchText", () => {
	it("a second call with the same key and a cache configured never invokes the underlying port again", async () => {
		const root = buildFixture();
		try {
			const textSearch = new CountingTextSearch(new RipgrepTextSearch());
			const cache = new InMemorySearchCache();
			const options = { maxMatches: 100, maxBytes: 10_000 };

			const first = await searchText(textSearch, cache, root, "ws-1", "hello", options);
			const second = await searchText(textSearch, cache, root, "ws-1", "hello", options);

			expect(textSearch.calls).toBe(1);
			expect(second).toEqual(first);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not cache transient indexed-search fallback states", async () => {
		const root = buildFixture();
		try {
			const inner: TextSearchPort = {
				search: async () => ({
					matches: [],
					truncated: false,
					provenance: { kind: "lexical", backend: "ripgrep", indexState: "loading" },
				}),
				findFiles: async () => ({ paths: [], truncated: false }),
			};
			const textSearch = new CountingTextSearch(inner);
			const cache = new InMemorySearchCache();
			const options = { maxMatches: 100, maxBytes: 10_000 };
			await searchText(textSearch, cache, root, "ws-1", "hello", options);
			await searchText(textSearch, cache, root, "ws-1", "hello", options);
			expect(textSearch.calls).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("with no cache configured, every call invokes the underlying port -- correct, just uncached", async () => {
		const root = buildFixture();
		try {
			const textSearch = new CountingTextSearch(new RipgrepTextSearch());
			const options = { maxMatches: 100, maxBytes: 10_000 };

			await searchText(textSearch, undefined, root, "ws-1", "hello", options);
			await searchText(textSearch, undefined, root, "ws-1", "hello", options);

			expect(textSearch.calls).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an unsafe query before ever touching the cache or the underlying port", async () => {
		const root = buildFixture();
		try {
			const textSearch = new CountingTextSearch(new RipgrepTextSearch());
			const cache = new InMemorySearchCache();

			await expect(searchText(textSearch, cache, root, "ws-1", "--upload-pack=evil", { maxMatches: 100, maxBytes: 1000 })).rejects.toBeInstanceOf(
				UnsafeSearchQuery,
			);
			expect(textSearch.calls).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
