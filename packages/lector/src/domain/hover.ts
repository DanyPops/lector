import type { CodeRange } from "../workspace/code-range.ts";

/** Type/doc information for the symbol at a position (LSP textDocument/hover, contents flattened to plain text/markdown). */
export interface Hover {
	readonly contents: string;
	readonly range?: CodeRange;
}
