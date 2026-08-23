/**
 * Proves every ground-truth corpus entry's relevantSymbols genuinely resolves against the real
 * materialized typescript-reference fixture via Lector's own TreeSitterSymbolIndex.findSymbols --
 * the corpus is wrong if it claims a symbol exists that a real query can't find.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { GROUND_TRUTH_CORPUS } from "../../../benchmarks/eval/ground-truth-corpus.ts";
import { TreeSitterSymbolIndex } from "../../../src/code-intelligence/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { materializeTypeScriptReferenceFixture, type TypeScriptReferenceFixture } from "../../support/typescript-reference-fixture.ts";

let fixture: TypeScriptReferenceFixture | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

describe("GROUND_TRUTH_CORPUS", () => {
	it("covers every required task category at least once", () => {
		const categories = new Set(GROUND_TRUTH_CORPUS.map((entry) => entry.category));
		expect(categories).toEqual(new Set(["lexical", "symbol-name", "cross-file-reference", "semantic-gap"]));
	});

	it("has no duplicate task ids", () => {
		const ids = GROUND_TRUTH_CORPUS.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("resolves every relevantSymbols entry to a real symbol at its claimed path via TreeSitterSymbolIndex", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const parser = new TreeSitterSymbolIndex(fixture.root);

		for (const entry of GROUND_TRUTH_CORPUS) {
			for (const reference of entry.relevantSymbols) {
				const result = await parser.findSymbols(reference.symbolName);
				const found = result.symbols.some((symbol) => symbol.name === reference.symbolName && symbol.location.path === reference.path);
				expect(found).toBe(true);
			}
		}
	}, 30_000);
});
