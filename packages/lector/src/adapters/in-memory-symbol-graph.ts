import Graph from "graphology";
import type { SymbolNodeId } from "../domain/symbol-node-id.ts";
import type { SymbolEdgeKind, SymbolGraphPort, SymbolNode } from "../ports/symbol-graph-port.ts";

/**
 * In-memory SymbolGraphPort for tests and small/ephemeral workspaces,
 * backed by graphology for node/edge storage (multi-edge and self-loop
 * support). reachableFrom is a small explicit bounded-depth BFS on top of
 * it, since graphology's own traversal helpers don't take a hop limit.
 */
export class InMemorySymbolGraph implements SymbolGraphPort {
	private readonly graph = new Graph({ type: "directed", multi: true, allowSelfLoops: true });
	private readonly nodes = new Map<SymbolNodeId, SymbolNode>();

	async addNode(node: SymbolNode): Promise<void> {
		this.nodes.set(node.id, node);
		if (!this.graph.hasNode(node.id)) this.graph.addNode(node.id);
	}

	async getNode(id: SymbolNodeId): Promise<SymbolNode | undefined> {
		return this.nodes.get(id);
	}

	async addEdge(from: SymbolNodeId, to: SymbolNodeId, kind: SymbolEdgeKind): Promise<void> {
		if (!this.graph.hasNode(from)) this.graph.addNode(from);
		if (!this.graph.hasNode(to)) this.graph.addNode(to);
		const edgeKey = `${from}->${to}:${kind}`;
		if (!this.graph.hasEdge(edgeKey)) this.graph.addEdgeWithKey(edgeKey, from, to, { kind });
	}

	async edgesFrom(id: SymbolNodeId, kind?: SymbolEdgeKind): Promise<readonly SymbolNodeId[]> {
		if (!this.graph.hasNode(id)) return [];
		return this.graph
			.outEdges(id)
			.filter((edgeKey) => !kind || this.graph.getEdgeAttribute(edgeKey, "kind") === kind)
			.map((edgeKey) => this.graph.target(edgeKey));
	}

	async edgesTo(id: SymbolNodeId, kind?: SymbolEdgeKind): Promise<readonly SymbolNodeId[]> {
		if (!this.graph.hasNode(id)) return [];
		return this.graph
			.inEdges(id)
			.filter((edgeKey) => !kind || this.graph.getEdgeAttribute(edgeKey, "kind") === kind)
			.map((edgeKey) => this.graph.source(edgeKey));
	}

	async reachableFrom(id: SymbolNodeId, options: { maxDepth: number; kind?: SymbolEdgeKind }): Promise<readonly SymbolNodeId[]> {
		if (options.maxDepth < 1 || !this.graph.hasNode(id)) return [];
		const reached = new Set<SymbolNodeId>();
		let frontier = new Set<SymbolNodeId>([id]);
		for (let depth = 0; depth < options.maxDepth && frontier.size > 0; depth++) {
			const next = new Set<SymbolNodeId>();
			for (const current of frontier) {
				for (const neighborId of await this.edgesFrom(current, options.kind)) {
					if (neighborId === id || reached.has(neighborId)) continue;
					reached.add(neighborId);
					next.add(neighborId);
				}
			}
			frontier = next;
		}
		return Array.from(reached);
	}

	async close(): Promise<void> {
		this.graph.clear();
		this.nodes.clear();
	}
}
