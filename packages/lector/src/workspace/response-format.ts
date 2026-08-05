import type { IntelligenceProvenance } from "../code-intelligence/intelligence-provenance.ts";
import type { SymbolSearchResult } from "./workspace-symbol.ts";

/** "detailed" (default) preserves every existing caller's current behavior unchanged. "concise" strips whatever is safely droppable without losing the ability to act on the result. */
export type ResponseFormat = "concise" | "detailed";

/** Only the two fields every existing renderer (describeIntelligenceSource/formatIntelligenceSource) actually reads -- languageId/authority/freshness/limitations are real detail, but no current caller consumes them from a per-result payload. */
export interface ConciseProvenance {
	readonly fidelity: IntelligenceProvenance["fidelity"];
	readonly backend: string;
}

export function toConciseProvenance(provenance: IntelligenceProvenance): ConciseProvenance {
	return { fidelity: provenance.fidelity, backend: provenance.backend };
}

export interface FormattedSymbol {
	readonly name: string;
	readonly kind: string;
	readonly location: SymbolSearchResult["symbols"][number]["location"];
}

export interface FormattedSymbolSearchResult {
	readonly symbols: readonly FormattedSymbol[];
	readonly truncated: boolean;
	readonly provenance: IntelligenceProvenance | ConciseProvenance;
	readonly completeness?: "complete" | "partial";
}

/**
 * "concise" strips find_symbols' containerName and per-symbol provenance
 * (only meaningful for a polyglot composite query, an edge case most
 * callers never inspect) and the top-level sources[] per-backend
 * breakdown (completeness alone already conveys "some backend failed") --
 * name/kind/location, the fields every real caller acts on, stay untouched.
 * "detailed" returns the exact original result unmodified.
 */
export function formatSymbolSearchResult(result: SymbolSearchResult, format: ResponseFormat): FormattedSymbolSearchResult {
	if (format === "detailed") return result;
	return {
		symbols: result.symbols.map((symbol) => ({ name: symbol.name, kind: symbol.kind, location: symbol.location })),
		truncated: result.truncated,
		provenance: toConciseProvenance(result.provenance),
		...(result.completeness ? { completeness: result.completeness } : {}),
	};
}

/**
 * For any Provenanced<T> result (find_references, hover, etc.) -- "concise"
 * narrows only the provenance envelope, leaving T (the actual payload)
 * untouched, since every current Provenanced<T> payload is already minimal.
 */
export function formatProvenanced<T extends { readonly provenance: IntelligenceProvenance }>(
	result: T,
	format: ResponseFormat,
): Omit<T, "provenance"> & { readonly provenance: IntelligenceProvenance | ConciseProvenance } {
	if (format === "detailed") return result;
	return { ...result, provenance: toConciseProvenance(result.provenance) };
}
