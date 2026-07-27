import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "../domain/call-hierarchy.ts";
import type { Diagnostic } from "../domain/diagnostic.ts";
import type { DocumentSymbolEntry } from "../domain/document-symbol.ts";
import type { Hover } from "../domain/hover.ts";
import type { IntelligenceProvenance, SymbolSearchBounds } from "../domain/intelligence-provenance.ts";
import type { SymbolSearchResult, WorkspaceLocation } from "../domain/workspace-symbol.ts";
import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { SymbolIndexPort } from "../ports/symbol-index-port.ts";

export type ClosableIntelligenceIndex = SymbolIndexPort & { close(): Promise<void> };

/** Structural fallbacks serve name discovery only; identity-aware operations always stay on the semantic primary. */
export class FallbackCodeIntelligenceIndex implements SymbolIndexPort, CodeIntelligencePort {
	readonly provenance: IntelligenceProvenance;

	constructor(
		private readonly primary: ClosableIntelligenceIndex & CodeIntelligencePort,
		private readonly fallbacks: readonly ClosableIntelligenceIndex[],
	) {
		this.provenance = primary.provenance;
	}

	async findSymbols(query: string, bounds?: SymbolSearchBounds): Promise<SymbolSearchResult> {
		try {
			return await this.primary.findSymbols(query, bounds);
		} catch (primaryError) {
			let emptyResult: SymbolSearchResult | undefined;
			for (const fallback of this.fallbacks) {
				try {
					const result = await fallback.findSymbols(query, bounds);
					if (result.symbols.length > 0) return result;
					emptyResult ??= result;
				} catch {
					// Continue through the bounded fallback chain; the primary error remains authoritative if none can answer.
				}
			}
			if (emptyResult) return emptyResult;
			throw primaryError;
		}
	}

	goToDefinition(at: WorkspaceLocation) {
		return this.primary.goToDefinition(at);
	}
	goToImplementation(at: WorkspaceLocation) {
		return this.primary.goToImplementation(at);
	}
	findReferences(at: WorkspaceLocation, includeDeclaration: boolean) {
		return this.primary.findReferences(at, includeDeclaration);
	}
	hover(at: WorkspaceLocation): Promise<Hover | undefined> {
		return this.primary.hover(at);
	}
	documentSymbols(path: string): Promise<DocumentSymbolEntry[]> {
		return this.primary.documentSymbols(path);
	}
	diagnostics(path: string): Promise<Diagnostic[]> {
		return this.primary.diagnostics(path);
	}
	prepareCallHierarchy(at: WorkspaceLocation): Promise<CallHierarchyEntry[]> {
		return this.primary.prepareCallHierarchy(at);
	}
	incomingCalls(at: WorkspaceLocation): Promise<IncomingCall[]> {
		return this.primary.incomingCalls(at);
	}
	outgoingCalls(at: WorkspaceLocation): Promise<OutgoingCall[]> {
		return this.primary.outgoingCalls(at);
	}
	releaseFile(path: string): Promise<void> {
		return this.primary.releaseFile?.(path) ?? Promise.resolve();
	}

	async close(): Promise<void> {
		await Promise.allSettled([this.primary.close(), ...this.fallbacks.map((fallback) => fallback.close())]);
	}
}
