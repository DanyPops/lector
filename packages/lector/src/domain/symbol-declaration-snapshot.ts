/**
 * One symbol's own declaration text as extracted from one version of a file's content --
 * deliberately independent of which git ref or "working tree" the content came from, the same
 * separation ContentSymbol keeps from WorkspaceSymbol.location.path.
 */
export interface SymbolDeclarationSnapshot {
	readonly found: boolean;
	readonly text?: string;
	readonly startLine?: number;
	readonly endLine?: number;
}
