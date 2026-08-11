import { extname } from "node:path";
import type { Diagnostic } from "../code-intelligence/diagnostic.ts";
import type { DocumentHighlight } from "../code-intelligence/document-highlight.ts";
import type { DocumentSymbolEntry } from "../code-intelligence/document-symbol.ts";
import type { Hover } from "../code-intelligence/hover.ts";
import type { IntelligenceProvenance, IntelligenceSourceOutcome, SymbolSearchBounds } from "../code-intelligence/intelligence-provenance.ts";
import type { LanguageServerDescriptor } from "../code-intelligence/language-server-descriptor.ts";
import type { CodeIntelligencePort } from "../code-intelligence/port.ts";
import type { SymbolIndexPort } from "../code-intelligence/symbol-index-port.ts";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "../symbol-graph/call-hierarchy.ts";
import type { ParsedWorkspaceEdit, RenameRange } from "../workspace/workspace-edit.ts";
import type { SymbolSearchResult, WorkspaceLocation, WorkspaceSymbol } from "../workspace/workspace-symbol.ts";

const MAX_SOURCE_ERROR_LENGTH = 500;
const MAX_LANGUAGE_INDEXES = 16;
const DEFAULT_MAX_RESULTS = 1_000;

export interface PolyglotIndexEntry {
	readonly descriptor: LanguageServerDescriptor;
	readonly index: SymbolIndexPort;
}

function boundedError(error: unknown): { code: string; message: string } {
	const code = error instanceof Error && error.name ? error.name : "CodeIntelligenceError";
	const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_SOURCE_ERROR_LENGTH);
	return { code, message };
}

function supportsCodeIntelligence(index: SymbolIndexPort): index is SymbolIndexPort & CodeIntelligencePort {
	return "goToDefinition" in index && typeof index.goToDefinition === "function";
}

function compareSymbols(left: WorkspaceSymbol, right: WorkspaceSymbol): number {
	return (
		left.location.path.localeCompare(right.location.path) ||
		left.location.line - right.location.line ||
		left.location.character - right.location.character ||
		left.name.localeCompare(right.name) ||
		left.kind.localeCompare(right.kind)
	);
}

export class PolyglotCodeIntelligenceIndex implements SymbolIndexPort, CodeIntelligencePort {
	readonly provenance: IntelligenceProvenance = {
		fidelity: "semantic",
		backend: "polyglot-language-servers",
		languageId: "polyglot",
		authority: "language-server",
		freshness: "live-process",
		limitations: [],
	};

	constructor(private readonly entries: readonly PolyglotIndexEntry[]) {
		if (entries.length === 0 || entries.length > MAX_LANGUAGE_INDEXES) {
			throw new TypeError(`polyglot index requires between 1 and ${MAX_LANGUAGE_INDEXES} language indexes`);
		}
	}

	private indexForPath(path: string): SymbolIndexPort & CodeIntelligencePort {
		const extension = extname(path);
		const entry = this.entries.find((candidate) => candidate.descriptor.extensions.includes(extension));
		if (!entry) throw new Error(`no language index available for extension "${extension}"`);
		if (!supportsCodeIntelligence(entry.index)) throw new Error(`code intelligence unavailable for ${entry.descriptor.languageId}`);
		return entry.index;
	}

	async findSymbols(query: string, bounds: SymbolSearchBounds = { maxResults: DEFAULT_MAX_RESULTS }): Promise<SymbolSearchResult> {
		if (!Number.isSafeInteger(bounds.maxResults) || bounds.maxResults < 1) throw new TypeError("maxResults must be a positive safe integer");
		const settled = await Promise.allSettled(this.entries.map(({ index }) => index.findSymbols(query, bounds)));
		const symbols: WorkspaceSymbol[] = [];
		const sources: IntelligenceSourceOutcome[] = [];
		let sourceTruncated = false;

		for (const [position, outcome] of settled.entries()) {
			const entry = this.entries[position];
			if (!entry) continue;
			if (outcome.status === "rejected") {
				sources.push({ provenance: entry.index.provenance, status: "failed", symbolCount: 0, error: boundedError(outcome.reason) });
				continue;
			}
			sources.push({
				provenance: outcome.value.provenance,
				status: "ready",
				symbolCount: outcome.value.symbols.length,
				truncated: outcome.value.truncated,
			});
			sourceTruncated ||= outcome.value.truncated;
			for (const symbol of outcome.value.symbols) symbols.push({ ...symbol, provenance: outcome.value.provenance });
		}

		symbols.sort(compareSymbols);
		const truncated = sourceTruncated || symbols.length > bounds.maxResults;
		return {
			symbols: symbols.slice(0, bounds.maxResults),
			truncated,
			provenance: this.provenance,
			completeness: sources.every((source) => source.status === "ready") ? "complete" : "partial",
			sources,
		};
	}

	provenanceForPath(path: string): IntelligenceProvenance {
		return this.indexForPath(path).provenance;
	}

	goToDefinition(at: WorkspaceLocation) {
		return this.indexForPath(at.path).goToDefinition(at);
	}

	goToImplementation(at: WorkspaceLocation) {
		return this.indexForPath(at.path).goToImplementation(at);
	}

	findReferences(at: WorkspaceLocation, includeDeclaration: boolean) {
		return this.indexForPath(at.path).findReferences(at, includeDeclaration);
	}

	hover(at: WorkspaceLocation): Promise<Hover | undefined> {
		return this.indexForPath(at.path).hover(at);
	}

	documentSymbols(path: string, options?: { settleMs?: number }): Promise<DocumentSymbolEntry[]> {
		return this.indexForPath(path).documentSymbols(path, options);
	}

	diagnostics(path: string): Promise<Diagnostic[]> {
		return this.indexForPath(path).diagnostics(path);
	}

	prepareCallHierarchy(at: WorkspaceLocation): Promise<CallHierarchyEntry[]> {
		return this.indexForPath(at.path).prepareCallHierarchy(at);
	}

	incomingCalls(at: WorkspaceLocation): Promise<IncomingCall[]> {
		return this.indexForPath(at.path).incomingCalls(at);
	}

	outgoingCalls(at: WorkspaceLocation, options?: { settleMs?: number }): Promise<OutgoingCall[]> {
		return this.indexForPath(at.path).outgoingCalls(at, options);
	}

	releaseFile(path: string): Promise<void> {
		return this.indexForPath(path).releaseFile?.(path) ?? Promise.resolve();
	}

	// Same live gap fixed in FallbackCodeIntelligenceIndex -- this second CodeIntelligencePort
	// wrapper also predates documentHighlights and must forward it explicitly.
	documentHighlights(at: WorkspaceLocation): Promise<DocumentHighlight[]> {
		return this.indexForPath(at.path).documentHighlights?.(at) ?? Promise.resolve([]);
	}

	prepareRename(at: WorkspaceLocation): Promise<RenameRange | null> {
		return this.indexForPath(at.path).prepareRename?.(at) ?? Promise.resolve(null);
	}

	async rename(at: WorkspaceLocation, newName: string): Promise<ParsedWorkspaceEdit> {
		const index = this.indexForPath(at.path);
		if (!index.rename) throw new Error(`no code-intelligence backend for "${at.path}" supports rename`);
		return index.rename(at, newName);
	}

	/**
	 * Dispatches to whichever single backend produced the rename's own edit (the first touched
	 * path's own index) -- a rename spanning two DIFFERENT language backends is beyond what a
	 * single textDocument/rename request can produce anyway (rename() above dispatches to exactly
	 * one index too), so there is exactly one relevant backend to notify here.
	 */
	notifyFilesWillRename(pairs: readonly { readonly fromPath: string; readonly toPath: string }[]): Promise<void> {
		const first = pairs[0];
		if (!first) return Promise.resolve();
		return this.indexForPath(first.fromPath).notifyFilesWillRename?.(pairs) ?? Promise.resolve();
	}

	notifyFilesDidRename(pairs: readonly { readonly fromPath: string; readonly toPath: string }[]): void {
		const first = pairs[0];
		if (!first) return;
		this.indexForPath(first.fromPath).notifyFilesDidRename?.(pairs);
	}

	notifyFilesWillCreate(paths: readonly string[]): Promise<void> {
		const first = paths[0];
		return first ? (this.indexForPath(first).notifyFilesWillCreate?.(paths) ?? Promise.resolve()) : Promise.resolve();
	}

	notifyFilesDidCreate(paths: readonly string[]): void {
		const first = paths[0];
		if (first) this.indexForPath(first).notifyFilesDidCreate?.(paths);
	}

	notifyFilesWillDelete(paths: readonly string[]): Promise<void> {
		const first = paths[0];
		return first ? (this.indexForPath(first).notifyFilesWillDelete?.(paths) ?? Promise.resolve()) : Promise.resolve();
	}

	notifyFilesDidDelete(paths: readonly string[]): void {
		const first = paths[0];
		if (first) this.indexForPath(first).notifyFilesDidDelete?.(paths);
	}
}
