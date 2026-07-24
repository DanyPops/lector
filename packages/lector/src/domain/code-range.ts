/**
 * A span within one workspace file: 1-indexed line/character, matching
 * WorkspaceLocation's own convention (humans and CLIs present positions
 * 1-indexed; the LSP wire format is 0-indexed -- adapters convert at the
 * boundary, domain code never sees LSP's raw 0-indexed Range).
 */
export interface CodeRange {
	readonly path: string;
	readonly start: { readonly line: number; readonly character: number };
	readonly end: { readonly line: number; readonly character: number };
}
