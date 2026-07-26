import type { SymbolIndexPort } from "../ports/symbol-index-port.ts";
import type { SymbolSearchBounds } from "./intelligence-provenance.ts";
import type { SymbolSearchResult } from "./workspace-symbol.ts";

/** Find workspace symbols matching a fuzzy query string. */
export async function findWorkspaceSymbols(index: SymbolIndexPort, query: string, bounds?: SymbolSearchBounds): Promise<SymbolSearchResult> {
	return index.findSymbols(query, bounds);
}
