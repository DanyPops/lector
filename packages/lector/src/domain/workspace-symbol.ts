import type { IntelligenceProvenance, IntelligenceSourceOutcome } from "./intelligence-provenance.ts";

/** A location within a workspace file: 1-indexed line and character, matching how humans and CLIs present positions. */
export interface WorkspaceLocation {
	readonly path: string;
	readonly line: number;
	readonly character: number;
}

/** One symbol found by a workspace-wide symbol search. */
export interface WorkspaceSymbol {
	readonly name: string;
	readonly kind: string;
	readonly location: WorkspaceLocation;
	readonly containerName?: string;
	/** Present when a workspace-wide composite query needs to preserve which backend produced this symbol. */
	readonly provenance?: IntelligenceProvenance;
}

export interface SymbolSearchResult {
	readonly symbols: readonly WorkspaceSymbol[];
	readonly truncated: boolean;
	readonly provenance: IntelligenceProvenance;
	/** Present for composite workspace queries; omitted for one-language adapters. */
	readonly completeness?: "complete" | "partial";
	readonly sources?: readonly IntelligenceSourceOutcome[];
}
