import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { SymbolGraphGeneration } from "./symbol-graph-generation.ts";
import type { SymbolNodeId } from "./symbol-node-id.ts";

/** A node's own identity and declaration -- what's shown, not derived relationships. */
export interface SymbolNode {
	readonly id: SymbolNodeId;
	readonly name: string;
	readonly kind: string;
	readonly location: WorkspaceLocation;
}

export type SymbolEdgeKind = "calls" | "references" | "contains";

/** One recorded edge, denormalized for bulk export -- symbol-graph-port's other methods only ever answer "who does X point to/from", never "give me every edge". */
export interface SymbolEdgeRecord {
	readonly from: SymbolNodeId;
	readonly to: SymbolNodeId;
	readonly kind: SymbolEdgeKind;
}

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
	/** Every node recorded at this exact path and line, any character -- the nearest-declaration fallback for an anchor position that misses getNode()'s own exact match: a live LSP query's own reported column can genuinely differ by a few characters from what documentSymbols' selectionRange.start recorded for the same declaration (e.g. workspace/symbol's own SymbolInformation.location vs. DocumentSymbol.selectionRange), even though hover/goToDefinition/findReferences all still resolve the same symbol. Bounded to one line, never a fuzzy whole-file search. */
	nodesAtLine(path: string, line: number): Promise<readonly SymbolNode[]>;
	addEdge(from: SymbolNodeId, to: SymbolNodeId, kind: SymbolEdgeKind): Promise<void>;
	/** Removes every node at this exact path and every edge touching one of them (both directions). A no-op if no node has this path. */
	removeNodesForFile(path: string): Promise<void>;
	/** Direct out-edges from `id` -- who/what `id` points to. */
	edgesFrom(id: SymbolNodeId, kind?: SymbolEdgeKind): Promise<readonly SymbolNodeId[]>;
	/** Direct in-edges to `id` -- who/what points to `id`. */
	edgesTo(id: SymbolNodeId, kind?: SymbolEdgeKind): Promise<readonly SymbolNodeId[]>;
	/** Every node reachable from `id` by following out-edges, up to `maxDepth` hops, excluding `id` itself. */
	reachableFrom(id: SymbolNodeId, options: { maxDepth: number; kind?: SymbolEdgeKind }): Promise<readonly SymbolNodeId[]>;
	getGeneration(): Promise<SymbolGraphGeneration | undefined>;
	setGeneration(generation: SymbolGraphGeneration): Promise<void>;
	/** Every node, bounded to maxNodes -- for whole-graph analyses (e.g. ranking) that genuinely need every node, unlike every other query here which starts from one id. */
	allNodes(maxNodes: number): Promise<readonly SymbolNode[]>;
	/** Every edge, bounded to maxEdges. */
	allEdges(maxEdges: number): Promise<readonly SymbolEdgeRecord[]>;
	close(): Promise<void>;
}
