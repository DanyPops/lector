import type { WorkspaceSymbol } from "../domain/workspace-symbol.ts";

/**
 * SymbolIndexPort -- the role a driven adapter plays for symbol queries:
 * given a fuzzy query string, return matching workspace symbols. Implemented
 * by an LSP-backed adapter and a tree-sitter-backed adapter; both satisfy
 * this same interface.
 */
export interface SymbolIndexPort {
	findSymbols(query: string): Promise<WorkspaceSymbol[]>;
}
