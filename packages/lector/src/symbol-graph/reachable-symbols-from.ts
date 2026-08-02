import type { SymbolEdgeKind, SymbolGraphPort, SymbolNode } from "./port.ts";
import type { SymbolNodeId } from "./symbol-node-id.ts";

/** Every real symbol node reachable from `id`, up to `maxDepth` hops -- ids the graph itself no longer knows about (a stale node) are dropped, not fabricated. */
export async function reachableSymbolsFrom(
	graph: SymbolGraphPort,
	id: SymbolNodeId,
	options: { maxDepth: number; kind?: SymbolEdgeKind },
): Promise<SymbolNode[]> {
	const ids = await graph.reachableFrom(id, options);
	const nodes = await Promise.all(ids.map((nodeId) => graph.getNode(nodeId)));
	return nodes.filter((node): node is SymbolNode => node !== undefined);
}
