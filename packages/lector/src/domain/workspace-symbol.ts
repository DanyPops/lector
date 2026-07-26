import type { IntelligenceProvenance } from "./intelligence-provenance.ts";

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
}

export interface SymbolSearchResult {
	readonly symbols: readonly WorkspaceSymbol[];
	readonly truncated: boolean;
	readonly provenance: IntelligenceProvenance;
}
