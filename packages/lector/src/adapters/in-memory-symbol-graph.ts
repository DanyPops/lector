import Graph from "graphology";
import type { SymbolGraphGeneration } from "../domain/symbol-graph-generation.ts";
import type { SymbolNodeId } from "../domain/symbol-node-id.ts";
import type { SymbolEdgeKind, SymbolEdgeRecord, SymbolGraphPort, SymbolNode } from "../ports/symbol-graph-port.ts";

/**
 * In-memory SymbolGraphPort for tests and small/ephemeral workspaces,
 * backed by graphology for node/edge storage (multi-edge and self-loop
 * support). reachableFrom is a small explicit bounded-depth BFS on top of
 * it, since graphology's own traversal helpers don't take a hop limit.
 */
export class InMemorySymbolGraph implements SymbolGraphPort {
	private readonly graph = new Graph({ type: "directed", multi: true, allowSelfLoops: true });
	private readonly nodes = new Map<SymbolNodeId, SymbolNode>();
	private generation: SymbolGraphGeneration | undefined;

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

	async removeNodesForFile(path: string): Promise<void> {
		for (const [id, node] of this.nodes) {
			if (node.location.path !== path) continue;
			this.nodes.delete(id);
			// dropNode also removes every edge touching it, in both directions.
			if (this.graph.hasNode(id)) this.graph.dropNode(id);
		}
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

	async allNodes(maxNodes: number): Promise<readonly SymbolNode[]> {
		return Array.from(this.nodes.values()).slice(0, maxNodes);
	}

	async allEdges(maxEdges: number): Promise<readonly SymbolEdgeRecord[]> {
		const records: SymbolEdgeRecord[] = [];
		for (const edgeKey of this.graph.edges()) {
			if (records.length >= maxEdges) break;
			// graphology's edge attributes are untyped by design; addEdge above is the only writer and
			// always sets a real SymbolEdgeKind.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			records.push({ from: this.graph.source(edgeKey), to: this.graph.target(edgeKey), kind: this.graph.getEdgeAttribute(edgeKey, "kind") as SymbolEdgeKind });
		}
		return records;
	}

	async getGeneration(): Promise<SymbolGraphGeneration | undefined> {
		return this.generation;
	}

	async setGeneration(generation: SymbolGraphGeneration): Promise<void> {
		this.generation = generation;
	}

	async close(): Promise<void> {
		this.graph.clear();
		this.nodes.clear();
		this.generation = undefined;
	}
}
