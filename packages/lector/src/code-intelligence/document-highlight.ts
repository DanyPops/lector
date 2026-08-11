import type { CodeRange } from "../workspace/code-range.ts";

/**
 * The role a same-symbol occurrence plays where it appears -- SCIP's own SymbolRole precedent
 * (ReadAccess/WriteAccess bits on Occurrence), the cheapest real, non-heuristic per-occurrence
 * signal available for "is this a read or a write", surfaced here via LSP's own
 * textDocument/documentHighlight (DocumentHighlightKind: 1=Text, 2=Read, 3=Write) rather than a
 * bespoke analysis. "text" mirrors LSP/SCIP's own fallback for a server that reports an
 * occurrence exists but declines to (or cannot) classify it as a read or a write.
 */
export type DocumentHighlightKind = "text" | "read" | "write";

/**
 * One other occurrence of the same symbol within the single already-open document containing the
 * queried position (LSP textDocument/documentHighlight) -- deliberately single-document, unlike
 * findReferences. LSP's own documentHighlight was never designed to answer "everywhere in the
 * workspace", only "every other occurrence of this same symbol in the file already open at this
 * position" -- folding it into findReferences' own cross-file result would require one
 * documentHighlight round trip per cross-file location, multiplying request volume for a call
 * that costs exactly one round trip today. Kept as its own bounded operation instead.
 */
export interface DocumentHighlight {
	readonly range: CodeRange;
	readonly kind: DocumentHighlightKind;
}
