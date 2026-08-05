import type { DocumentSymbolEntry } from "./document-symbol.ts";
import type { CodeIntelligencePort } from "./port.ts";

/** Every symbol declared in one file, hierarchically. */
export async function documentSymbols(index: CodeIntelligencePort, path: string): Promise<DocumentSymbolEntry[]> {
	return index.documentSymbols(path);
}
