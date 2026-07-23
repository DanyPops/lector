import type { WorkspaceSymbol } from "../domain/workspace-symbol.ts";

/**
 * SymbolIndexPort -- the role a driven adapter plays for symbol queries:
 * given a fuzzy query string, return matching workspace symbols. Implemented
 * by an LSP-backed adapter for the walking skeleton; a persisted tree-sitter
 * graph is a possible future adapter for the same port (doc 9c15958b's
 * open question on the index layer).
 */
export interface SymbolIndexPort {
	findSymbols(query: string): Promise<WorkspaceSymbol[]>;
}
