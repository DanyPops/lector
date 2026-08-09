import type { Diagnostic } from "../code-intelligence/diagnostic.ts";
import type { DocumentSymbolEntry } from "../code-intelligence/document-symbol.ts";
import type { Hover } from "../code-intelligence/hover.ts";
import type { IntelligenceProvenance, SymbolSearchBounds } from "../code-intelligence/intelligence-provenance.ts";
import type { CodeIntelligencePort } from "../code-intelligence/port.ts";
import type { SymbolIndexPort } from "../code-intelligence/symbol-index-port.ts";
import type { FileChangeEvent } from "../file-watcher/file-change-event.ts";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "../symbol-graph/call-hierarchy.ts";
import type { ParsedWorkspaceEdit, RenameRange } from "../workspace/workspace-edit.ts";
import type { SymbolSearchResult, WorkspaceLocation } from "../workspace/workspace-symbol.ts";

export type ClosableIntelligenceIndex = SymbolIndexPort & { close(): Promise<void>; isAlive?(): boolean };

/** Structural fallbacks serve name discovery only; identity-aware operations always stay on the semantic primary. */
export class FallbackCodeIntelligenceIndex implements SymbolIndexPort, CodeIntelligencePort {
	readonly provenance: IntelligenceProvenance;

	constructor(
		private readonly primary: ClosableIntelligenceIndex & CodeIntelligencePort,
		private readonly fallbacks: readonly ClosableIntelligenceIndex[],
	) {
		this.provenance = primary.provenance;
	}

	isAlive(): boolean {
		return this.primary.isAlive?.() ?? true;
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
	documentSymbols(path: string, options?: { settleMs?: number }): Promise<DocumentSymbolEntry[]> {
		return this.primary.documentSymbols(path, options);
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
	outgoingCalls(at: WorkspaceLocation, options?: { settleMs?: number }): Promise<OutgoingCall[]> {
		return this.primary.outgoingCalls(at, options);
	}
	releaseFile(path: string): Promise<void> {
		return this.primary.releaseFile?.(path) ?? Promise.resolve();
	}
	notifyFileChanged(event: FileChangeEvent): void {
		this.primary.notifyFileChanged?.(event);
	}
	prepareRename(at: WorkspaceLocation): Promise<RenameRange | null> {
		return this.primary.prepareRename?.(at) ?? Promise.resolve(null);
	}
	async rename(at: WorkspaceLocation, newName: string): Promise<ParsedWorkspaceEdit> {
		if (!this.primary.rename) throw new Error("the primary code-intelligence backend does not support rename");
		return this.primary.rename(at, newName);
	}
	notifyFilesWillRename(pairs: readonly { readonly fromPath: string; readonly toPath: string }[]): Promise<void> {
		return this.primary.notifyFilesWillRename?.(pairs) ?? Promise.resolve();
	}
	notifyFilesDidRename(pairs: readonly { readonly fromPath: string; readonly toPath: string }[]): void {
		this.primary.notifyFilesDidRename?.(pairs);
	}
	notifyFilesWillCreate(paths: readonly string[]): Promise<void> {
		return this.primary.notifyFilesWillCreate?.(paths) ?? Promise.resolve();
	}
	notifyFilesDidCreate(paths: readonly string[]): void {
		this.primary.notifyFilesDidCreate?.(paths);
	}
	notifyFilesWillDelete(paths: readonly string[]): Promise<void> {
		return this.primary.notifyFilesWillDelete?.(paths) ?? Promise.resolve();
	}
	notifyFilesDidDelete(paths: readonly string[]): void {
		this.primary.notifyFilesDidDelete?.(paths);
	}

	async close(): Promise<void> {
		await Promise.allSettled([this.primary.close(), ...this.fallbacks.map((fallback) => fallback.close())]);
	}
}
