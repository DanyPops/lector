import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { DocumentSymbolEntry } from "./document-symbol.ts";

/** Every symbol declared in one file, hierarchically. */
export async function documentSymbols(index: CodeIntelligencePort, path: string): Promise<DocumentSymbolEntry[]> {
	return index.documentSymbols(path);
}
