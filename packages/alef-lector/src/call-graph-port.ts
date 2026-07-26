import { callLector } from "./client.js";
import type { WorkspacePosition } from "./code-intelligence-port.js";
import { registerWorkspace } from "./workspace-registration.js";

/** Mirrors Alef's CallGraphPort v1 contract (@dpopsuev/alef-workspace/call-graph-port) structurally. */
export type SymbolEdgeKind = "calls" | "references" | "contains";

export interface SymbolNode {
	readonly id: string;
	readonly name: string;
	readonly kind: string;
	readonly location: WorkspacePosition;
}

export interface PopulateSymbolGraphResult {
	readonly completeness: "complete" | "partial";
	readonly filesProcessed: number;
	readonly filesFailed: number;
	readonly nodesAdded: number;
	readonly edgesAdded: number;
}

/** CallGraphPort backed by a real Lector daemon's persisted symbol-graph operations. */
export class LectorCallGraphPort {
	readonly version = 1 as const;

	constructor(private readonly root: string) {}

	async populateSymbolGraph(maxFiles: number, maxSymbolsPerFile: number): Promise<PopulateSymbolGraphResult> {
		const workspaceId = await registerWorkspace(this.root);
		const result = await callLector("workspace.populateSymbolGraph", { workspaceId, maxFiles, maxSymbolsPerFile });
		return {
			completeness: result.completeness,
			filesProcessed: result.filesProcessed,
			filesFailed: result.filesFailed,
			nodesAdded: result.nodesAdded,
			edgesAdded: result.edgesAdded,
		};
	}

	async edgesFrom(at: WorkspacePosition, kind?: SymbolEdgeKind): Promise<readonly SymbolNode[]> {
		const workspaceId = await registerWorkspace(this.root);
		const { symbols } = await callLector("workspace.symbolEdgesFrom", { workspaceId, path: at.path, line: at.line, character: at.character, kind });
		return symbols;
	}

	async edgesTo(at: WorkspacePosition, kind?: SymbolEdgeKind): Promise<readonly SymbolNode[]> {
		const workspaceId = await registerWorkspace(this.root);
		const { symbols } = await callLector("workspace.symbolEdgesTo", { workspaceId, path: at.path, line: at.line, character: at.character, kind });
		return symbols;
	}

	async reachableFrom(at: WorkspacePosition, maxDepth: number, kind?: SymbolEdgeKind): Promise<readonly SymbolNode[]> {
		const workspaceId = await registerWorkspace(this.root);
		const { symbols } = await callLector("workspace.reachableFrom", {
			workspaceId,
			path: at.path,
			line: at.line,
			character: at.character,
			maxDepth,
			kind,
		});
		return symbols;
	}
}
