import type { Diagnostic, DocumentSymbolEntry } from "@danypops/lector";

/** Only "error"/"warning" ever surface -- an "info"/"hint" on every keystroke would make the hint noisier than the edit it's attached to. */
function isNoteworthy(diagnostic: Diagnostic): boolean {
	return diagnostic.severity === "error" || diagnostic.severity === "warning";
}

/**
 * A one-line note appended after edit/write on an LSP-supported file with a
 * warm index already available -- mirrors pi-lsp-lite's real precedent of
 * surfacing diagnostics inline with the edit result, so a caught type error
 * doesn't wait for a separate diagnostics call to be noticed. Undefined
 * when there is nothing noteworthy to say.
 */
export function buildPostEditDiagnosticsHint(diagnostics: readonly Diagnostic[]): string | undefined {
	const noteworthy = diagnostics.filter(isNoteworthy);
	if (noteworthy.length === 0) return undefined;
	const errorCount = noteworthy.filter((d) => d.severity === "error").length;
	const warningCount = noteworthy.length - errorCount;
	const parts: string[] = [];
	if (errorCount > 0) parts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
	if (warningCount > 0) parts.push(`${warningCount} warning${warningCount === 1 ? "" : "s"}`);
	return `Lector: ${parts.join(", ")} on this file (see the diagnostics tool for detail).`;
}

/** Below this, a read already shows the whole structure at a glance -- a hint would just be noise. */
const MIN_SYMBOLS_FOR_HINT = 8;

/**
 * A one-line note appended after reading a large, LSP-supported file with a
 * warm index already available -- nudges toward document_symbols/
 * find_references/go_to_definition instead of re-reading the whole file for
 * a targeted question next time.
 */
export function buildPostReadStructureHint(symbols: readonly DocumentSymbolEntry[]): string | undefined {
	if (symbols.length < MIN_SYMBOLS_FOR_HINT) return undefined;
	return `Lector: this file has ${symbols.length} top-level symbols -- document_symbols/find_references/go_to_definition can target one directly instead of rereading the whole file.`;
}
