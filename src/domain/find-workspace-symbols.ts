import type { SymbolIndexPort } from "../ports/symbol-index-port.ts";
import type { WorkspaceSymbol } from "./workspace-symbol.ts";

/** Find workspace symbols matching a fuzzy query string. */
export async function findWorkspaceSymbols(index: SymbolIndexPort, query: string): Promise<WorkspaceSymbol[]> {
	return index.findSymbols(query);
}
