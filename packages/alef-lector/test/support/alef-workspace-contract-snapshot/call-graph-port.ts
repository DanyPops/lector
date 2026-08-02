/**
 * Pinned snapshot of Alef's real @dpopsuev/alef-workspace/call-graph-port contract
 * (CallGraphPort v1), copied verbatim from
 * /home/dpopsuev/Workspace/alef/packages/core/workspace/src/call-graph-port.ts as of
 * 2026-08-02. See git-port.ts's own snapshot header for the full rationale -- applies
 * identically here.
 */
import type { WorkspacePosition } from "./code-intelligence-port.ts";

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

export interface CallGraphPort {
	readonly version: 1;
	populateSymbolGraph(maxFiles: number, maxSymbolsPerFile: number): Promise<PopulateSymbolGraphResult>;
	edgesFrom(at: WorkspacePosition, kind?: SymbolEdgeKind): Promise<readonly SymbolNode[]>;
	edgesTo(at: WorkspacePosition, kind?: SymbolEdgeKind): Promise<readonly SymbolNode[]>;
	reachableFrom(at: WorkspacePosition, maxDepth: number, kind?: SymbolEdgeKind): Promise<readonly SymbolNode[]>;
}
