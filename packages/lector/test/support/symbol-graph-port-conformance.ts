/**
 * Shared conformance suite for any SymbolGraphPort implementation. Every
 * adapter (InMemorySymbolGraph, SqliteSymbolGraph, and any future one) must
 * pass this unmodified. Covers node/edge round-tripping, edge-kind
 * filtering, and the depth-bounded reachability semantics that are the
 * actual point of this port over a flat edge list.
 */
import { describe, expect, it } from "bun:test";
import type { SymbolGraphPort, SymbolNode } from "../../src/symbol-graph/port.ts";
import type { SymbolGraphGeneration } from "../../src/symbol-graph/symbol-graph-generation.ts";
import { deriveSymbolNodeId, type SymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";

export interface SymbolGraphConformanceHarness {
	createGraph(): SymbolGraphPort | Promise<SymbolGraphPort>;
	cleanup?(graph: SymbolGraphPort): void | Promise<void>;
}

/** Derives a real, valid SymbolNodeId from an arbitrary short label -- this suite exercises graph storage in the abstract, so the real path/line/character values don't matter, only that each label maps to one stable, distinct id. */
function nid(label: string): SymbolNodeId {
	return deriveSymbolNodeId({ path: label, line: 1, character: 1 });
}

function node(label: string, name: string): SymbolNode {
	return { id: nid(label), name, kind: "function", location: { path: `/src/${name}.ts`, line: 1, character: 1 } };
}

export function runSymbolGraphPortConformanceSuite(name: string, harness: SymbolGraphConformanceHarness): void {
	async function withGraph<T>(fn: (graph: SymbolGraphPort) => Promise<T>): Promise<T> {
		const graph = await harness.createGraph();
		try {
			return await fn(graph);
		} finally {
			await harness.cleanup?.(graph);
		}
	}

	describe(`SymbolGraphPort conformance: ${name}`, () => {
		it("returns undefined for a node id nothing was ever added under", () =>
			withGraph(async (graph) => {
				expect(await graph.getNode(nid("never-added"))).toBeUndefined();
			}));

		it("round-trips a node's own name, kind, and location", () =>
			withGraph(async (graph) => {
				const a = node("a", "handleRequest");
				await graph.addNode(a);
				expect(await graph.getNode(nid("a"))).toEqual(a);
			}));

		it("edgesFrom/edgesTo are empty for a node with no edges, not an error", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				expect(await graph.edgesFrom(nid("a"))).toEqual([]);
				expect(await graph.edgesTo(nid("a"))).toEqual([]);
			}));

		it("edgesFrom/edgesTo are empty for a node id that was never added at all", () =>
			withGraph(async (graph) => {
				expect(await graph.edgesFrom(nid("nothing-here"))).toEqual([]);
				expect(await graph.edgesTo(nid("nothing-here"))).toEqual([]);
			}));

		it("records a direct edge in both directions -- edgesFrom(a) includes b, edgesTo(b) includes a", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				await graph.addNode(node("b", "b"));
				await graph.addEdge(nid("a"), nid("b"), "calls");

				expect(await graph.edgesFrom(nid("a"))).toEqual([nid("b")]);
				expect(await graph.edgesTo(nid("b"))).toEqual([nid("a")]);
				expect(await graph.edgesFrom(nid("b"))).toEqual([]);
				expect(await graph.edgesTo(nid("a"))).toEqual([]);
			}));

		it("filters edges by kind when asked, and two different kinds between the same pair coexist", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				await graph.addNode(node("b", "b"));
				await graph.addEdge(nid("a"), nid("b"), "calls");
				await graph.addEdge(nid("a"), nid("b"), "references");

				expect(await graph.edgesFrom(nid("a"), "calls")).toEqual([nid("b")]);
				expect(await graph.edgesFrom(nid("a"), "references")).toEqual([nid("b")]);
				expect(await graph.edgesFrom(nid("a"), "contains")).toEqual([]);
				expect(Array.from(await graph.edgesFrom(nid("a"))).sort()).toEqual([nid("b"), nid("b")].sort());
			}));

		it("adding the same edge twice does not duplicate it", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				await graph.addNode(node("b", "b"));
				await graph.addEdge(nid("a"), nid("b"), "calls");
				await graph.addEdge(nid("a"), nid("b"), "calls");

				expect(await graph.edgesFrom(nid("a"), "calls")).toEqual([nid("b")]);
			}));

		it("reachableFrom finds multi-hop targets within maxDepth, excluding the start node itself", () =>
			withGraph(async (graph) => {
				// a -> b -> c -> d
				for (const label of ["a", "b", "c", "d"]) await graph.addNode(node(label, label));
				await graph.addEdge(nid("a"), nid("b"), "calls");
				await graph.addEdge(nid("b"), nid("c"), "calls");
				await graph.addEdge(nid("c"), nid("d"), "calls");

				expect(Array.from(await graph.reachableFrom(nid("a"), { maxDepth: 1 })).sort()).toEqual([nid("b")]);
				expect(Array.from(await graph.reachableFrom(nid("a"), { maxDepth: 2 })).sort()).toEqual([nid("b"), nid("c")].sort());
				expect(Array.from(await graph.reachableFrom(nid("a"), { maxDepth: 10 })).sort()).toEqual([nid("b"), nid("c"), nid("d")].sort());
				expect(await graph.reachableFrom(nid("a"), { maxDepth: 10 })).not.toContain(nid("a"));
			}));

		it("reachableFrom respects an edge-kind filter", () =>
			withGraph(async (graph) => {
				// a -[calls]-> b -[contains]-> c
				for (const label of ["a", "b", "c"]) await graph.addNode(node(label, label));
				await graph.addEdge(nid("a"), nid("b"), "calls");
				await graph.addEdge(nid("b"), nid("c"), "contains");

				expect(await graph.reachableFrom(nid("a"), { maxDepth: 10, kind: "calls" })).toEqual([nid("b")]);
				expect(await graph.reachableFrom(nid("a"), { maxDepth: 10 })).toContain(nid("c"));
			}));

		it("reachableFrom does not loop forever or return duplicates when the graph has a real cycle", () =>
			withGraph(async (graph) => {
				// a -> b -> a (mutual recursion)
				await graph.addNode(node("a", "a"));
				await graph.addNode(node("b", "b"));
				await graph.addEdge(nid("a"), nid("b"), "calls");
				await graph.addEdge(nid("b"), nid("a"), "calls");

				const reached = await graph.reachableFrom(nid("a"), { maxDepth: 10 });
				expect(reached).toEqual([nid("b")]);
			}));

		it("reachableFrom returns nothing for maxDepth 0 or less", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				await graph.addNode(node("b", "b"));
				await graph.addEdge(nid("a"), nid("b"), "calls");

				expect(await graph.reachableFrom(nid("a"), { maxDepth: 0 })).toEqual([]);
			}));

		it("returns no completed generation before a successful population records one", () =>
			withGraph(async (graph) => {
				expect(await graph.getGeneration()).toBeUndefined();
			}));

		it("round-trips completed generation metadata independently of graph nodes", () =>
			withGraph(async (graph) => {
				const generation: SymbolGraphGeneration = {
					sourceFingerprint: "abc123",
					maxFiles: 100,
					maxSymbolsPerFile: 50,
					completedAt: 123456,
					provenance: {
						fidelity: "semantic",
						backend: "test-language-server",
						languageId: "test",
						authority: "language-server",
						freshness: "live-process",
						limitations: [],
					},
					result: {
						completeness: "complete",
						filesAttempted: 4,
						filesProcessed: 4,
						filesFailed: 0,
						symbolsProcessed: 12,
						nodesAdded: 10,
						edgesAdded: 8,
						failureCount: 0,
						failures: [],
						failuresTruncated: false,
					},
				};
				await graph.setGeneration(generation);
				expect(await graph.getGeneration()).toEqual(generation);
			}));

		it("allNodes returns every added node, and allEdges returns every added edge", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				await graph.addNode(node("b", "b"));
				await graph.addEdge(nid("a"), nid("b"), "calls");

				const nodes = await graph.allNodes(10);
				expect(nodes.map((n) => n.id).sort()).toEqual([nid("a"), nid("b")].sort());
				const edges = await graph.allEdges(10);
				expect(edges).toEqual([{ from: nid("a"), to: nid("b"), kind: "calls" }]);
			}));

		it("allNodes/allEdges are bounded by maxNodes/maxEdges", () =>
			withGraph(async (graph) => {
				for (const label of ["a", "b", "c"]) await graph.addNode(node(label, label));
				await graph.addEdge(nid("a"), nid("b"), "calls");
				await graph.addEdge(nid("b"), nid("c"), "calls");

				expect((await graph.allNodes(2)).length).toBe(2);
				expect((await graph.allEdges(1)).length).toBe(1);
			}));

		it("allNodes/allEdges return empty arrays for a graph with nothing added, not an error", () =>
			withGraph(async (graph) => {
				expect(await graph.allNodes(10)).toEqual([]);
				expect(await graph.allEdges(10)).toEqual([]);
			}));

		it("removeNodesForFile deletes every node at that path plus every edge touching one of them", () =>
			withGraph(async (graph) => {
				// a, b both live in the same deleted file; c is untouched.
				const a: SymbolNode = { id: nid("a"), name: "a", kind: "function", location: { path: "/src/gone.ts", line: 1, character: 1 } };
				const b: SymbolNode = { id: nid("b"), name: "b", kind: "function", location: { path: "/src/gone.ts", line: 5, character: 1 } };
				const c: SymbolNode = { id: nid("c"), name: "c", kind: "function", location: { path: "/src/stays.ts", line: 1, character: 1 } };
				await graph.addNode(a);
				await graph.addNode(b);
				await graph.addNode(c);
				await graph.addEdge(nid("a"), nid("b"), "calls");
				await graph.addEdge(nid("c"), nid("a"), "calls"); // an edge from a surviving file into the deleted one

				await graph.removeNodesForFile("/src/gone.ts");

				expect(await graph.getNode(nid("a"))).toBeUndefined();
				expect(await graph.getNode(nid("b"))).toBeUndefined();
				expect(await graph.getNode(nid("c"))).toEqual(c);
				expect(await graph.edgesFrom(nid("c"))).toEqual([]);
				expect(await graph.edgesTo(nid("b"))).toEqual([]);
			}));

		it("removeNodesForFile is a no-op when no node has that path", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				await graph.removeNodesForFile("/src/never-added.ts");
				expect(await graph.getNode(nid("a"))).toEqual(node("a", "a"));
			}));

		it("does not let edges/nodes touching one graph affect a separately created one", () =>
			withGraph(async (graphA) => {
				await withGraph(async (graphB) => {
					await graphA.addNode(node("a", "a"));
					await graphA.addNode(node("b", "b"));
					await graphA.addEdge(nid("a"), nid("b"), "calls");

					expect(await graphB.getNode(nid("a"))).toBeUndefined();
					expect(await graphB.edgesFrom(nid("a"))).toEqual([]);
				});
			}));
	});
}
