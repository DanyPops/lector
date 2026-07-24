import type { SymbolNodeId } from "../domain/symbol-node-id.ts";
import type { WorkspaceLocation } from "../domain/workspace-symbol.ts";

/** A node's own identity and declaration -- what's shown, not derived relationships. */
export interface SymbolNode {
	readonly id: SymbolNodeId;
	readonly name: string;
	readonly kind: string;
	readonly location: WorkspaceLocation;
}

export type SymbolEdgeKind = "calls" | "references" | "contains";

/**
 * SymbolGraphPort -- a persisted, queryable graph of symbol relationships,
 * populated by a batch indexing pass rather than answered live per query,
 * so multi-hop questions (transitive callers, reachability) don't require
 * chaining many sequential LSP calls. maxDepth is required: an unbounded
 * traversal has no place in a bounded-resource daemon.
 */
export interface SymbolGraphPort {
	addNode(node: SymbolNode): Promise<void>;
	getNode(id: SymbolNodeId): Promise<SymbolNode | undefined>;
	addEdge(from: SymbolNodeId, to: SymbolNodeId, kind: SymbolEdgeKind): Promise<void>;
	/** Direct out-edges from `id` -- who/what `id` points to. */
	edgesFrom(id: SymbolNodeId, kind?: SymbolEdgeKind): Promise<readonly SymbolNodeId[]>;
	/** Direct in-edges to `id` -- who/what points to `id`. */
	edgesTo(id: SymbolNodeId, kind?: SymbolEdgeKind): Promise<readonly SymbolNodeId[]>;
	/** Every node reachable from `id` by following out-edges, up to `maxDepth` hops, excluding `id` itself. */
	reachableFrom(id: SymbolNodeId, options: { maxDepth: number; kind?: SymbolEdgeKind }): Promise<readonly SymbolNodeId[]>;
	close(): Promise<void>;
}
