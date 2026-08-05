import type { CodeRange } from "../workspace/code-range.ts";

/**
 * A symbol declared in one specific file (LSP textDocument/documentSymbol),
 * hierarchical -- e.g. a class's methods nest under the class -- unlike the
 * flat, workspace-wide WorkspaceSymbol find_symbols already returns. Not
 * every server (or backend) can honestly resolve `children`; when it can't,
 * it is simply absent, never fabricated as an empty array.
 */
export interface DocumentSymbolEntry {
	readonly name: string;
	readonly kind: string;
	readonly detail?: string;
	/** Encloses the whole declaration, including its body. */
	readonly range: CodeRange;
	/** The narrower span that should be selected/revealed -- typically just the name. */
	readonly selectionRange: CodeRange;
	readonly children?: readonly DocumentSymbolEntry[];
}
