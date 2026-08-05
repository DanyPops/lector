export type IntelligenceFidelity = "semantic" | "structural";

export interface IntelligenceProvenance {
	readonly fidelity: IntelligenceFidelity;
	readonly backend: string;
	readonly languageId: string;
	readonly authority: "language-server" | "parser" | "compiler";
	readonly freshness: "live-process" | "content-hash" | "filesystem-snapshot";
	readonly limitations: readonly string[];
}

export interface IntelligenceSourceOutcome {
	readonly provenance: IntelligenceProvenance;
	readonly status: "ready" | "failed";
	readonly symbolCount: number;
	readonly truncated?: boolean;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface SymbolSearchBounds {
	readonly maxResults: number;
}

export interface ProvenancedResult<T> {
	readonly result: T;
	readonly provenance: IntelligenceProvenance;
}
