import type { SymbolNode } from "../symbol-graph/port.ts";

/**
 * Picks the single unambiguous nearest-declaration match for an anchor position that missed an
 * exact getNode() lookup -- a live LSP query's own reported column can genuinely differ by a few
 * characters from what documentSymbols' selectionRange.start recorded for the same declaration
 * (workspace/symbol's own SymbolInformation.location vs. DocumentSymbol.selectionRange is one
 * real, observed source of this), even though hover/goToDefinition/findReferences all still
 * resolve the same symbol. Never guesses across an ambiguous same-line tie -- undefined means
 * "still not resolvable," the caller's own UnknownAnnotationAnchor stays correct.
 */
export function nearestDeclarationAt(candidates: readonly SymbolNode[], character: number): SymbolNode | undefined {
	if (candidates.length === 0) return undefined;
	let best: SymbolNode | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	let tied = false;
	for (const candidate of candidates) {
		const distance = Math.abs(candidate.location.character - character);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
			tied = false;
		} else if (distance === bestDistance) {
			tied = true;
		}
	}
	return tied ? undefined : best;
}
