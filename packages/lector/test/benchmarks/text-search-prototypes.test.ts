/**
 * Contract-conformance tests for the three indexed-lexical-search prototypes (xgrep, FFF,
 * zoekt) proving each genuinely implements TextSearchPort's real search behavior against a real
 * fixture before the benchmark trusts any timing it produces -- an unverified number is worse
 * than no number.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FffTextSearch } from "../../benchmarks/text-search-prototypes/fff-text-search.ts";
import { XgrepTextSearch } from "../../benchmarks/text-search-prototypes/xgrep-text-search.ts";
import { ZoektTextSearch } from "../../benchmarks/text-search-prototypes/zoekt-text-search.ts";

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-indexed-search-fixture-"));
	writeFileSync(join(root, "math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
	writeFileSync(join(root, "unrelated.ts"), "export const irrelevant = 1;\n");
	return root;
}

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("XgrepTextSearch", () => {
	it("finds a real match after buildIndex, respecting maxMatches", async () => {
		root = buildFixture();
		const adapter = new XgrepTextSearch();
		adapter.buildIndex(root);

		const result = await adapter.search(root, "add", { maxMatches: 10, maxBytes: 4096 });

		expect(result.matches.length).toBeGreaterThan(0);
		expect(result.matches.some((match) => match.path === "math.ts" && match.line.includes("add"))).toBe(true);
		expect(result.truncated).toBe(false);
	});

	it("reports a real index size after buildIndex", async () => {
		root = buildFixture();
		const adapter = new XgrepTextSearch();
		adapter.buildIndex(root);

		expect(adapter.indexSizeBytes(root)).toBeGreaterThan(0);
	});
});

describe("FffTextSearch", () => {
	it("finds a real match after openAndScan, respecting maxMatches", async () => {
		root = buildFixture();
		const adapter = new FffTextSearch();
		try {
			await adapter.openAndScan(root, 10_000);
			const result = await adapter.search(root, "add", { maxMatches: 10, maxBytes: 4096 });

			expect(result.matches.length).toBeGreaterThan(0);
			expect(result.matches.some((match) => match.path === "math.ts" && match.line.includes("add"))).toBe(true);
		} finally {
			adapter.destroyAll();
		}
	}, 20_000);

	it("finds files via glob after openAndScan", async () => {
		root = buildFixture();
		const adapter = new FffTextSearch();
		try {
			await adapter.openAndScan(root, 10_000);
			const result = await adapter.findFiles(root, ["*.ts"], { maxResults: 10, maxBytes: 4096 });

			expect([...result.paths].sort()).toEqual(["math.ts", "unrelated.ts"]);
		} finally {
			adapter.destroyAll();
		}
	}, 20_000);
});

describe("ZoektTextSearch", () => {
	it("finds a real match after buildIndex, respecting maxMatches", async () => {
		root = buildFixture();
		const indexDir = mkdtempSync(join(tmpdir(), "lector-zoekt-index-"));
		try {
			const adapter = new ZoektTextSearch(indexDir);
			await adapter.buildIndex(root);
			const result = await adapter.search(root, "add", { maxMatches: 10, maxBytes: 4096 });

			expect(result.matches.length).toBeGreaterThan(0);
			expect(result.matches.some((match) => match.path === "math.ts" && match.line.includes("add"))).toBe(true);
		} finally {
			rmSync(indexDir, { recursive: true, force: true });
		}
	}, 20_000);
});
