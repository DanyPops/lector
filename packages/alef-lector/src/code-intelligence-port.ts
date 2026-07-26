import { callLector } from "./client.js";
import { registerWorkspace } from "./workspace-registration.js";

/** Mirrors Alef's CodeIntelligencePort v1 contract (@dpopsuev/alef-workspace/code-intelligence-port) structurally. */
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

/** CodeIntelligencePort backed by a real Lector daemon's warm language-server-backed operations. */
export class LectorCodeIntelligencePort {
	readonly version = 1 as const;

	constructor(private readonly root: string) {}

	private async position(at: WorkspacePosition): Promise<{ workspaceId: string; path: string; line: number; character: number }> {
		const workspaceId = await registerWorkspace(this.root);
		return { workspaceId, path: at.path, line: at.line, character: at.character };
	}

	async goToDefinition(at: WorkspacePosition): Promise<readonly WorkspaceLocation[]> {
		const { locations } = await callLector("workspace.goToDefinition", await this.position(at));
		return locations;
	}

	async goToImplementation(at: WorkspacePosition): Promise<readonly WorkspaceLocation[]> {
		const { locations } = await callLector("workspace.goToImplementation", await this.position(at));
		return locations;
	}

	async findReferences(at: WorkspacePosition, includeDeclaration: boolean): Promise<readonly WorkspaceLocation[]> {
		const { locations } = await callLector("workspace.findReferences", { ...(await this.position(at)), includeDeclaration });
		return locations;
	}

	async hover(at: WorkspacePosition): Promise<Hover | undefined> {
		const { hover } = await callLector("workspace.hover", await this.position(at));
		return hover;
	}

	async documentSymbols(path: string): Promise<readonly DocumentSymbolEntry[]> {
		const workspaceId = await registerWorkspace(this.root);
		const { symbols } = await callLector("workspace.documentSymbols", { workspaceId, path });
		return symbols;
	}

	async diagnostics(path: string): Promise<readonly Diagnostic[]> {
		const workspaceId = await registerWorkspace(this.root);
		const { diagnostics } = await callLector("workspace.diagnostics", { workspaceId, path });
		return diagnostics;
	}

	async prepareCallHierarchy(at: WorkspacePosition): Promise<readonly CallHierarchyEntry[]> {
		const { items } = await callLector("workspace.prepareCallHierarchy", await this.position(at));
		return items;
	}

	async incomingCalls(at: WorkspacePosition): Promise<readonly IncomingCall[]> {
		const { calls } = await callLector("workspace.incomingCalls", await this.position(at));
		return calls;
	}

	async outgoingCalls(at: WorkspacePosition): Promise<readonly OutgoingCall[]> {
		const { calls } = await callLector("workspace.outgoingCalls", await this.position(at));
		return calls;
	}
}
