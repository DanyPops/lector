import { describe, expect, it } from "bun:test";
import type { IntelligenceProvenance } from "../../src/code-intelligence/intelligence-provenance.ts";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import type { SymbolGraphPopulationFailure } from "../../src/symbol-graph/populate-symbol-graph.ts";
import { summarizeCacheFailures, summarizeCacheGeneration } from "../../src/symbol-graph/summarize-cache-generation.ts";
import type { SymbolGraphGeneration } from "../../src/symbol-graph/symbol-graph-generation.ts";

const PROVENANCE: IntelligenceProvenance = {
	fidelity: "semantic",
	backend: "gopls",
	languageId: "go",
	authority: "language-server",
	freshness: "live-process",
	limitations: [],
};

function failure(overrides: Partial<SymbolGraphPopulationFailure> = {}): SymbolGraphPopulationFailure {
	return {
		path: "/repo/a.go",
		operation: "document-symbols",
		code: "CodeIntelligenceFileError",
		message: "no package metadata",
		provenance: PROVENANCE,
		...overrides,
	};
}

describe("summarizeCacheFailures", () => {
	it("passes distinct files with the same error through as separate entries, not collapsed", () => {
		const { failureSummary, failureSummaryTruncated } = summarizeCacheFailures([failure({ path: "/repo/a.go" }), failure({ path: "/repo/b.go" })]);
		expect(failureSummary.map((entry) => entry.path)).toEqual(["/repo/a.go", "/repo/b.go"]);
		expect(failureSummaryTruncated).toBe(false);
	});

	it("collapses a literal duplicate (path, operation, code) into one entry with a count", () => {
		const { failureSummary } = summarizeCacheFailures([failure(), failure(), failure()]);
		expect(failureSummary).toEqual([
			{ path: "/repo/a.go", operation: "document-symbols", code: "CodeIntelligenceFileError", message: "no package metadata", count: 3 },
		]);
	});

	it("truncates its own message shorter than a raw failure's own bound", () => {
		const longMessage = "x".repeat(500);
		const { failureSummary } = summarizeCacheFailures([failure({ message: longMessage })]);
		expect(failureSummary[0]?.message.length).toBeLessThan(500);
		expect(failureSummary[0]?.message.length).toBeLessThanOrEqual(160);
	});

	it("bounds the number of distinct summary entries and reports truncation honestly", () => {
		const failures = Array.from({ length: 30 }, (_, index) => failure({ path: `/repo/file-${index}.go` }));
		const { failureSummary, failureSummaryTruncated } = summarizeCacheFailures(failures);
		expect(failureSummary.length).toBe(20);
		expect(failureSummaryTruncated).toBe(true);
	});

	it("reports no truncation for an empty failure list", () => {
		expect(summarizeCacheFailures([])).toEqual({ failureSummary: [], failureSummaryTruncated: false });
	});
});

describe("summarizeCacheGeneration", () => {
	function generation(overrides: Partial<SymbolGraphGeneration> = {}): SymbolGraphGeneration {
		return {
			sourceFingerprint: "x",
			maxFiles: 500,
			maxSymbolsPerFile: 100,
			completedAt: 1_700_000_000_000,
			walkedFiles: ["/repo/a.go", "/repo/b.go", "/repo/c.go"],
			fileContentHashes: { "/repo/a.go": contentHashOf("a"), "/repo/b.go": contentHashOf("b") },
			result: {
				completeness: "partial",
				filesAttempted: 3,
				filesProcessed: 2,
				filesFailed: 1,
				symbolsProcessed: 10,
				nodesAdded: 10,
				edgesAdded: 4,
				failureCount: 1,
				failures: [failure({ path: "/repo/c.go" })],
				failuresTruncated: false,
			},
			...overrides,
		};
	}

	it("never carries walkedFiles or fileContentHashes -- reports only a count", () => {
		const summary = summarizeCacheGeneration(generation());
		expect(summary.walkedFileCount).toBe(3);
		expect(summary).not.toHaveProperty("walkedFiles");
		expect(summary).not.toHaveProperty("fileContentHashes");
	});

	it("preserves every count a caller needs to render cache status, unchanged", () => {
		const summary = summarizeCacheGeneration(generation());
		expect(summary.completedAt).toBe(1_700_000_000_000);
		expect(summary.maxFiles).toBe(500);
		expect(summary.maxSymbolsPerFile).toBe(100);
		expect(summary.result).toMatchObject({
			completeness: "partial",
			filesAttempted: 3,
			filesProcessed: 2,
			filesFailed: 1,
			symbolsProcessed: 10,
			nodesAdded: 10,
			edgesAdded: 4,
			failureCount: 1,
		});
	});

	it("replaces the raw failures array with a deduplicated summary, never both", () => {
		const summary = summarizeCacheGeneration(generation());
		expect(summary.result).not.toHaveProperty("failures");
		expect(summary.result.failureSummary).toEqual([
			{ path: "/repo/c.go", operation: "document-symbols", code: "CodeIntelligenceFileError", message: "no package metadata", count: 1 },
		]);
	});

	it("reports failureSummaryTruncated when the underlying generation's own failures list was already truncated at its 100-entry cap", () => {
		const summary = summarizeCacheGeneration(generation({ result: { ...generation().result, failuresTruncated: true } }));
		expect(summary.result.failureSummaryTruncated).toBe(true);
	});

	it("defaults walkedFileCount to zero for a generation persisted before purge-on-regeneration existed", () => {
		const summary = summarizeCacheGeneration(generation({ walkedFiles: undefined }));
		expect(summary.walkedFileCount).toBe(0);
	});
});
