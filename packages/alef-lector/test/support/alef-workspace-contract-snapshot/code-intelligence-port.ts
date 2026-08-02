/**
 * Pinned snapshot of Alef's real @dpopsuev/alef-workspace/code-intelligence-port contract
 * (CodeIntelligencePort v1), copied verbatim from
 * /home/dpopsuev/Workspace/alef/packages/core/workspace/src/code-intelligence-port.ts as of
 * 2026-08-02. See git-port.ts's own snapshot header for the full rationale -- applies
 * identically here.
 */

export interface WorkspacePosition {
	readonly path: string;
	readonly line: number;
	readonly character: number;
}

export type WorkspaceLocation = WorkspacePosition;

export interface CodeRange {
	readonly path: string;
	readonly start: { readonly line: number; readonly character: number };
	readonly end: { readonly line: number; readonly character: number };
}

export interface DocumentSymbolEntry {
	readonly name: string;
	readonly kind: string;
	readonly detail?: string;
	readonly range: CodeRange;
	readonly selectionRange: CodeRange;
	readonly children?: readonly DocumentSymbolEntry[];
}

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface Diagnostic {
	readonly range: CodeRange;
	readonly severity: DiagnosticSeverity;
	readonly message: string;
	readonly source?: string;
	readonly code?: string | number;
}

export interface Hover {
	readonly contents: string;
	readonly range?: CodeRange;
}

export interface CallHierarchyEntry {
	readonly name: string;
	readonly kind: string;
	readonly detail?: string;
	readonly location: WorkspaceLocation;
	readonly range: CodeRange;
}

export interface IncomingCall {
	readonly from: CallHierarchyEntry;
	readonly fromRanges: readonly CodeRange[];
}

export interface OutgoingCall {
	readonly to: CallHierarchyEntry;
	readonly fromRanges: readonly CodeRange[];
}

export interface CodeIntelligencePort {
	readonly version: 1;
	goToDefinition(at: WorkspacePosition): Promise<readonly WorkspaceLocation[]>;
	goToImplementation(at: WorkspacePosition): Promise<readonly WorkspaceLocation[]>;
	findReferences(at: WorkspacePosition, includeDeclaration: boolean): Promise<readonly WorkspaceLocation[]>;
	hover(at: WorkspacePosition): Promise<Hover | undefined>;
	documentSymbols(path: string): Promise<readonly DocumentSymbolEntry[]>;
	diagnostics(path: string): Promise<readonly Diagnostic[]>;
	prepareCallHierarchy(at: WorkspacePosition): Promise<readonly CallHierarchyEntry[]>;
	incomingCalls(at: WorkspacePosition): Promise<readonly IncomingCall[]>;
	outgoingCalls(at: WorkspacePosition): Promise<readonly OutgoingCall[]>;
}
