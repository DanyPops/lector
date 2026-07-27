import { extname } from "node:path";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "../domain/call-hierarchy.ts";
import type { Diagnostic } from "../domain/diagnostic.ts";
import type { DocumentSymbolEntry } from "../domain/document-symbol.ts";
import type { Hover } from "../domain/hover.ts";
import type { IntelligenceProvenance, IntelligenceSourceOutcome, SymbolSearchBounds } from "../domain/intelligence-provenance.ts";
import type { LanguageServerDescriptor } from "../domain/language-server-descriptor.ts";
import type { SymbolSearchResult, WorkspaceLocation, WorkspaceSymbol } from "../domain/workspace-symbol.ts";
import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { SymbolIndexPort } from "../ports/symbol-index-port.ts";

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
}
