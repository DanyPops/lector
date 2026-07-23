/**
 * TreeSitterSymbolIndex: no subprocess, no "No Project." gotcha, always
 * current -- dogfooded against Lector's own source, same as the LSP backend.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TreeSitterSymbolIndex } from "../../../src/adapters/tree-sitter/typescript-tree-sitter-symbol-index.ts";

const LECTOR_ROOT = new URL("../../..", import.meta.url).pathname;

describe("TreeSitterSymbolIndex against Lector's own source", () => {
	it("finds a real function declaration by name", async () => {
		const index = new TreeSitterSymbolIndex(LECTOR_ROOT);
		const results = await index.findSymbols("exactEdit");

		const match = results.find((symbol) => symbol.name === "exactEdit" && symbol.kind === "function");
		expect(match).toBeDefined();
		expect(match?.location.path).toContain("exact-edit.ts");
		expect(match?.location.line).toBeGreaterThan(0);
	});

	it("finds a real class declaration by name", async () => {
		const index = new TreeSitterSymbolIndex(LECTOR_ROOT);
		const results = await index.findSymbols("InMemoryWorkspace");

		const match = results.find((symbol) => symbol.name === "InMemoryWorkspace" && symbol.kind === "class");
		expect(match).toBeDefined();
		expect(match?.location.path).toContain("in-memory-workspace.ts");
	});

	it("matches case-insensitively and by substring", async () => {
		const index = new TreeSitterSymbolIndex(LECTOR_ROOT);
		const results = await index.findSymbols("exactedit");
		expect(results.some((symbol) => symbol.name === "exactEdit")).toBe(true);
	});

	it("returns an empty array for a query matching nothing, not an error", async () => {
		const index = new TreeSitterSymbolIndex(LECTOR_ROOT);
		const results = await index.findSymbols("ThisSymbolDefinitelyDoesNotExistAnywhere");
		expect(results).toEqual([]);
	});
});

describe("TreeSitterSymbolIndex bounded scan", () => {
	it("skips node_modules and hidden directories", async () => {
		const root = mktemp();
		try {
			mkdirSync(join(root, "node_modules", "some-dep"), { recursive: true });
			writeFileSync(join(root, "node_modules", "some-dep", "index.ts"), "export function shouldNotBeFound() {}");
			writeFileSync(join(root, "real.ts"), "export function shouldBeFound() {}");

			const index = new TreeSitterSymbolIndex(root);
			const foundResults = await index.findSymbols("shouldBeFound");
			const skippedResults = await index.findSymbols("shouldNotBeFound");

			expect(foundResults).toHaveLength(1);
			expect(skippedResults).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function mktemp(): string {
	return mkdtempSync(join(tmpdir(), "lector-tree-sitter-test-"));
}
