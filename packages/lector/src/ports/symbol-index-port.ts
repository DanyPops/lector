import type { IntelligenceProvenance, SymbolSearchBounds } from "../domain/intelligence-provenance.ts";
import type { SymbolSearchResult } from "../domain/workspace-symbol.ts";

/**
 * SymbolIndexPort -- the role a driven adapter plays for symbol queries:
 * given a fuzzy query string, return matching workspace symbols. Implemented
 * by an LSP-backed adapter and a tree-sitter-backed adapter; both satisfy
 * this same interface.
 */
export interface SymbolIndexPort {
	readonly provenance: IntelligenceProvenance;
	findSymbols(query: string, bounds?: SymbolSearchBounds): Promise<SymbolSearchResult>;
}
