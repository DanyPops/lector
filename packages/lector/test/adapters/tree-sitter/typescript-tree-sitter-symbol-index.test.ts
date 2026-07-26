/**
 * TreeSitterSymbolIndex: no subprocess, no "No Project." gotcha, always
 * current -- dogfooded against Lector's own source, same as the LSP backend.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryContentCache } from "../../../src/adapters/in-memory-content-cache.ts";
import { TreeSitterSymbolIndex } from "../../../src/adapters/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import type { ContentHash } from "../../../src/domain/content-hash.ts";
import { contentHashOf } from "../../../src/domain/content-hash.ts";
import type { ContentCacheEntry, ContentCachePort, ContentSymbol } from "../../../src/ports/content-cache-port.ts";

/** Counts get/putSymbols calls per hash, so a test can observe cache hit vs. miss directly instead of only inferring it from output correctness. */
class CountingContentCache implements ContentCachePort {
	private readonly delegate = new InMemoryContentCache();
	readonly getCalls: ContentHash[] = [];
	readonly putSymbolsCalls: ContentHash[] = [];

	async get(hash: ContentHash): Promise<ContentCacheEntry | undefined> {
		this.getCalls.push(hash);
		return this.delegate.get(hash);
	}

	async putRawContent(hash: ContentHash, content: string): Promise<void> {
		return this.delegate.putRawContent(hash, content);
	}

	async putSymbols(hash: ContentHash, symbols: readonly ContentSymbol[]): Promise<void> {
		this.putSymbolsCalls.push(hash);
		return this.delegate.putSymbols(hash, symbols);
	}
}

const LECTOR_ROOT = new URL("../../..", import.meta.url).pathname;

describe("TreeSitterSymbolIndex against Lector's own source", () => {
	it("finds a real function declaration by name", async () => {
		const index = new TreeSitterSymbolIndex(LECTOR_ROOT);
		const results = await index.findSymbols("exactEdit");

		const match = results.symbols.find((symbol) => symbol.name === "exactEdit" && symbol.kind === "function");
		expect(match).toBeDefined();
		expect(match?.location.path).toContain("exact-edit.ts");
		expect(match?.location.line).toBeGreaterThan(0);
	});

	it("finds a real class declaration by name", async () => {
		const index = new TreeSitterSymbolIndex(LECTOR_ROOT);
		const results = await index.findSymbols("InMemoryWorkspace");

		const match = results.symbols.find((symbol) => symbol.name === "InMemoryWorkspace" && symbol.kind === "class");
		expect(match).toBeDefined();
		expect(match?.location.path).toContain("in-memory-workspace.ts");
	});

	it("matches case-insensitively and by substring", async () => {
		const index = new TreeSitterSymbolIndex(LECTOR_ROOT);
		const results = await index.findSymbols("exactedit");
		expect(results.symbols.some((symbol) => symbol.name === "exactEdit")).toBe(true);
	});

	it("returns an empty array for a query matching nothing, not an error", async () => {
		const index = new TreeSitterSymbolIndex(LECTOR_ROOT);
		const results = await index.findSymbols("ThisSymbolDefinitelyDoesNotExistAnywhere");
		expect(results.symbols).toEqual([]);
	});
});

describe("TreeSitterSymbolIndex bounded scan", () => {
	it("selects files deterministically when the file bound truncates the scan", async () => {
		const root = mktemp();
		try {
			writeFileSync(join(root, "z.ts"), "export function fromZ() {}");
			writeFileSync(join(root, "a.ts"), "export function fromA() {}");
			const index = new TreeSitterSymbolIndex(root, undefined, { maxFiles: 1 });

			expect((await index.findSymbols("fromA")).symbols).toHaveLength(1);
			expect((await index.findSymbols("fromZ")).symbols).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips node_modules and hidden directories", async () => {
		const root = mktemp();
		try {
			mkdirSync(join(root, "node_modules", "some-dep"), { recursive: true });
			writeFileSync(join(root, "node_modules", "some-dep", "index.ts"), "export function shouldNotBeFound() {}");
			writeFileSync(join(root, "real.ts"), "export function shouldBeFound() {}");

			const index = new TreeSitterSymbolIndex(root);
			const foundResults = await index.findSymbols("shouldBeFound");
			const skippedResults = await index.findSymbols("shouldNotBeFound");

			expect(foundResults.symbols).toHaveLength(1);
			expect(skippedResults.symbols).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function mktemp(): string {
	return mkdtempSync(join(tmpdir(), "lector-tree-sitter-test-"));
}

describe("TreeSitterSymbolIndex content-addressed caching", () => {
	it("parses a file once, then serves a second query for the same unchanged file from the cache", async () => {
		const root = mktemp();
		try {
			writeFileSync(join(root, "a.ts"), "export function add() {}");
			const cache = new CountingContentCache();
			const index = new TreeSitterSymbolIndex(root, cache);

			await index.findSymbols("add");
			const putsAfterFirstQuery = cache.putSymbolsCalls.length;
			expect(putsAfterFirstQuery).toBe(1);

			await index.findSymbols("add");
			// A second query against the same unchanged file must hit the cache, not parse again --
			// no additional putSymbols call for a hash already cached.
			expect(cache.putSymbolsCalls.length).toBe(putsAfterFirstQuery);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("warms the raw-content lens for a hash even though only findSymbols (never rawRead) touched it", async () => {
		const root = mktemp();
		try {
			const source = "export function add() {}";
			writeFileSync(join(root, "a.ts"), source);
			const cache = new InMemoryContentCache();
			const index = new TreeSitterSymbolIndex(root, cache);

			await index.findSymbols("add");

			// code-intel -> fs warming: findSymbols read the file to parse it, so the fs lens for
			// that same content hash must already be populated for a subsequent plain read to hit.
			const entry = await cache.get(contentHashOf(source));
			expect(entry?.rawContent).toBe(source);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("attaches the querying file's own path to cached symbols, not the path of whichever file first populated that hash", async () => {
		const root = mktemp();
		try {
			const identicalSource = "export function sharedName() {}";
			mkdirSync(join(root, "first"));
			mkdirSync(join(root, "second"));
			writeFileSync(join(root, "first", "a.ts"), identicalSource);
			writeFileSync(join(root, "second", "a.ts"), identicalSource);

			const cache = new InMemoryContentCache();
			const index = new TreeSitterSymbolIndex(root, cache);
			const results = await index.findSymbols("sharedName");

			const paths = results.symbols.map((symbol) => symbol.location.path).sort();
			expect(paths).toEqual([join("first", "a.ts"), join("second", "a.ts")].sort());
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
