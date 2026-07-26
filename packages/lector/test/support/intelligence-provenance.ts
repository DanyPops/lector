import type { IntelligenceProvenance, SymbolSearchResult, WorkspaceSymbol } from "../../src/index.ts";

export const TEST_SEMANTIC_PROVENANCE: IntelligenceProvenance = {
	fidelity: "semantic",
	backend: "test-language-server",
	languageId: "test",
	authority: "language-server",
	freshness: "live-process",
	limitations: [],
};

export function symbolSearchResult(symbols: readonly WorkspaceSymbol[] = [], truncated = false): SymbolSearchResult {
	return { symbols, truncated, provenance: TEST_SEMANTIC_PROVENANCE };
}
