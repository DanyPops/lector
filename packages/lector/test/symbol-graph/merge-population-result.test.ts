import { describe, expect, it } from "bun:test";
import { mergePopulationResult } from "../../src/symbol-graph/merge-population-result.ts";
import type { PopulateSymbolGraphResult } from "../../src/symbol-graph/populate-symbol-graph.ts";

const reprocessResult: PopulateSymbolGraphResult = {
	completeness: "complete",
	filesAttempted: 3,
	filesProcessed: 3,
	filesFailed: 0,
	symbolsProcessed: 9,
	nodesAdded: 9,
	edgesAdded: 4,
	failureCount: 0,
	failures: [],
	failuresTruncated: false,
};

describe("mergePopulationResult", () => {
	it("rescopes filesAttempted/filesProcessed to the whole workspace, crediting skipped files as processed", () => {
		const merged = mergePopulationResult(reprocessResult, 37, 40);

		expect(merged.filesAttempted).toBe(40);
		expect(merged.filesProcessed).toBe(40);
	});

	it("keeps failure/symbol/edge counts scoped to this round's own reprocessed work", () => {
		const merged = mergePopulationResult(reprocessResult, 37, 40);

		expect(merged.symbolsProcessed).toBe(9);
		expect(merged.nodesAdded).toBe(9);
		expect(merged.edgesAdded).toBe(4);
	});

	it("preserves a partial completeness from real failures in the reprocessed subset", () => {
		const partial: PopulateSymbolGraphResult = { ...reprocessResult, completeness: "partial", filesFailed: 1, failureCount: 1 };

		const merged = mergePopulationResult(partial, 10, 11);

		expect(merged.completeness).toBe("partial");
		expect(merged.filesFailed).toBe(1);
	});

	it("is a no-op pass-through when nothing was skipped", () => {
		const merged = mergePopulationResult(reprocessResult, 0, 3);
		expect(merged).toEqual(reprocessResult);
	});
});
