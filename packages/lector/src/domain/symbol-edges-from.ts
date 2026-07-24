import type { SymbolEdgeKind, SymbolGraphPort, SymbolNode } from "../ports/symbol-graph-port.ts";
import type { SymbolNodeId } from "./symbol-node-id.ts";

/** Every real symbol node `id` directly points to (one hop) -- ids the graph no longer knows about are dropped, not fabricated. */
export async function symbolEdgesFrom(graph: SymbolGraphPort, id: SymbolNodeId, kind?: SymbolEdgeKind): Promise<SymbolNode[]> {
	const ids = await graph.edgesFrom(id, kind);
	const nodes = await Promise.all(ids.map((nodeId) => graph.getNode(nodeId)));
	return nodes.filter((node): node is SymbolNode => node !== undefined);
}
