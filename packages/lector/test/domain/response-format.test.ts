import { describe, expect, it } from "bun:test";
import type { IntelligenceProvenance } from "../../src/domain/intelligence-provenance.ts";
import { formatProvenanced, formatSymbolSearchResult, toConciseProvenance } from "../../src/domain/response-format.ts";
import type { SymbolSearchResult } from "../../src/domain/workspace-symbol.ts";

const FULL_PROVENANCE: IntelligenceProvenance = {
	fidelity: "semantic",
	backend: "typescript-language-server",
	languageId: "typescript",
	authority: "language-server",
	freshness: "live-process",
	limitations: ["cannot resolve dynamic requires", "no cross-package inference"],
};

function searchResult(overrides: Partial<SymbolSearchResult> = {}): SymbolSearchResult {
	return {
		symbols: [
			{ name: "add", kind: "function", location: { path: "src/math.ts", line: 1, character: 17 }, containerName: "MathUtils", provenance: FULL_PROVENANCE },
		],
		truncated: false,
		provenance: FULL_PROVENANCE,
		completeness: "complete",
		sources: [{ provenance: FULL_PROVENANCE, status: "ready", symbolCount: 1 }],
		...overrides,
	};
}

describe("toConciseProvenance", () => {
	it("keeps only fidelity and backend", () => {
		expect(toConciseProvenance(FULL_PROVENANCE)).toEqual({ fidelity: "semantic", backend: "typescript-language-server" });
	});
});

describe("formatSymbolSearchResult", () => {
	it('"detailed" returns the exact original result, unchanged', () => {
		const result = searchResult();
		expect(formatSymbolSearchResult(result, "detailed")).toBe(result);
	});

	it('"concise" strips containerName and per-symbol provenance from every symbol', () => {
		const concise = formatSymbolSearchResult(searchResult(), "concise");
		expect(concise.symbols[0]).toEqual({ name: "add", kind: "function", location: { path: "src/math.ts", line: 1, character: 17 } });
		expect(concise.symbols[0]).not.toHaveProperty("containerName");
		expect(concise.symbols[0]).not.toHaveProperty("provenance");
	});

	it('"concise" narrows the top-level provenance and drops sources[]', () => {
		const concise = formatSymbolSearchResult(searchResult(), "concise");
		expect(concise.provenance).toEqual({ fidelity: "semantic", backend: "typescript-language-server" });
		expect(concise).not.toHaveProperty("sources");
	});

	it('"concise" preserves completeness when present, and omits it when absent', () => {
		const withCompleteness = formatSymbolSearchResult(searchResult({ completeness: "partial" }), "concise");
		expect(withCompleteness.completeness).toBe("partial");

		const { completeness, ...rest } = searchResult();
		const withoutCompleteness = formatSymbolSearchResult(rest as SymbolSearchResult, "concise");
		expect(withoutCompleteness).not.toHaveProperty("completeness");
	});

	it('"concise" preserves truncated', () => {
		const concise = formatSymbolSearchResult(searchResult({ truncated: true }), "concise");
		expect(concise.truncated).toBe(true);
	});
});

describe("formatProvenanced", () => {
	it('"detailed" leaves the provenance envelope unchanged', () => {
		const result = { locations: [{ path: "src/math.ts", line: 1, character: 17 }], provenance: FULL_PROVENANCE };
		expect(formatProvenanced(result, "detailed")).toEqual(result);
	});

	it('"concise" narrows only the provenance envelope, leaving the payload untouched', () => {
		const result = { locations: [{ path: "src/math.ts", line: 1, character: 17 }], provenance: FULL_PROVENANCE };
		const concise = formatProvenanced(result, "concise");
		expect(concise.locations).toEqual(result.locations);
		expect(concise.provenance).toEqual({ fidelity: "semantic", backend: "typescript-language-server" });
	});
});
