/**
 * reachableSymbolsFrom's own filtering logic against a fake SymbolGraphPort -- the real
 * conformance-tested adapters (InMemorySymbolGraph, SqliteSymbolGraph) already guarantee
 * removeNodesForFile deletes a node's edges alongside the node itself, so engineering a
 * genuine "an edge points to a missing node" condition through their real API isn't
 * possible. A fake exercises exactly the one behavior this function documents: dropping,
 * not fabricating, an id the graph no longer has a real node for.
 */
import { describe, expect, it } from "bun:test";
import type { SymbolEdgeKind, SymbolGraphPort, SymbolNode } from "../../src/symbol-graph/port.ts";
import { reachableSymbolsFrom } from "../../src/symbol-graph/reachable-symbols-from.ts";
import { deriveSymbolNodeId, type SymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";

/** Derives a real, valid SymbolNodeId from an arbitrary short label -- only used as an opaque, distinct handle here. */
function nid(label: string): SymbolNodeId {
	return deriveSymbolNodeId({ path: label, line: 1, character: 1 });
}

function node(label: string): SymbolNode {
	return { id: nid(label), name: label, kind: "function", location: { path: "a.ts", line: 1, character: 1 } };
}

/** Answers reachableFrom/getNode from fixed maps; every other method throws -- never called by reachableSymbolsFrom. */
function fakeGraph(reachable: readonly SymbolNodeId[], nodesById: ReadonlyMap<SymbolNodeId, SymbolNode>): SymbolGraphPort {
	const unimplemented = (): never => {
		throw new Error("not implemented -- unused by reachableSymbolsFrom");
	};
	return {
		addNode: unimplemented,
		getNode: (id: SymbolNodeId) => Promise.resolve(nodesById.get(id)),
		addEdge: unimplemented,
		removeNodesForFile: unimplemented,
		edgesFrom: unimplemented,
		edgesTo: unimplemented,
		reachableFrom: (_id: SymbolNodeId, _options: { maxDepth: number; kind?: SymbolEdgeKind }) => Promise.resolve(reachable),
		getGeneration: unimplemented,
		setGeneration: unimplemented,
		allNodes: unimplemented,
		allEdges: unimplemented,
		close: unimplemented,
	};
}

describe("reachableSymbolsFrom", () => {
	it("returns the real node for every reachable id the graph still has", async () => {
		const graph = fakeGraph(
			[nid("b"), nid("c")],
			new Map([
				[nid("b"), node("b")],
				[nid("c"), node("c")],
			]),
		);
		const result = await reachableSymbolsFrom(graph, nid("a"), { maxDepth: 2 });
		expect(result).toEqual([node("b"), node("c")]);
	});

	it("drops a reachable id the graph no longer has a node for, rather than fabricating or surfacing undefined", async () => {
		const graph = fakeGraph(
			[nid("b"), nid("stale-id"), nid("c")],
			new Map([
				[nid("b"), node("b")],
				[nid("c"), node("c")],
			]),
		);
		const result = await reachableSymbolsFrom(graph, nid("a"), { maxDepth: 2 });
		expect(result).toEqual([node("b"), node("c")]);
		expect(result).not.toContain(undefined);
	});

	it("returns an empty array when every reachable id is stale", async () => {
		const graph = fakeGraph([nid("stale-1"), nid("stale-2")], new Map());
		const result = await reachableSymbolsFrom(graph, nid("a"), { maxDepth: 2 });
		expect(result).toEqual([]);
	});
});
