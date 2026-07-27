/**
 * Shared conformance suite for any SymbolGraphPort implementation. Every
 * adapter (InMemorySymbolGraph, SqliteSymbolGraph, and any future one) must
 * pass this unmodified. Covers node/edge round-tripping, edge-kind
 * filtering, and the depth-bounded reachability semantics that are the
 * actual point of this port over a flat edge list.
 */
import { describe, expect, it } from "bun:test";
import type { SymbolGraphGeneration } from "../../src/domain/symbol-graph-generation.ts";
import type { SymbolGraphPort, SymbolNode } from "../../src/ports/symbol-graph-port.ts";

export interface SymbolGraphConformanceHarness {
	createGraph(): SymbolGraphPort | Promise<SymbolGraphPort>;
	cleanup?(graph: SymbolGraphPort): void | Promise<void>;
}

function node(id: string, name: string): SymbolNode {
	return { id, name, kind: "function", location: { path: `/src/${name}.ts`, line: 1, character: 1 } };
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
				expect(await graph.getNode("never-added")).toBeUndefined();
			}));

		it("round-trips a node's own name, kind, and location", () =>
			withGraph(async (graph) => {
				const a = node("a", "handleRequest");
				await graph.addNode(a);
				expect(await graph.getNode("a")).toEqual(a);
			}));

		it("edgesFrom/edgesTo are empty for a node with no edges, not an error", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				expect(await graph.edgesFrom("a")).toEqual([]);
				expect(await graph.edgesTo("a")).toEqual([]);
			}));

		it("edgesFrom/edgesTo are empty for a node id that was never added at all", () =>
			withGraph(async (graph) => {
				expect(await graph.edgesFrom("nothing-here")).toEqual([]);
				expect(await graph.edgesTo("nothing-here")).toEqual([]);
			}));

		it("records a direct edge in both directions -- edgesFrom(a) includes b, edgesTo(b) includes a", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				await graph.addNode(node("b", "b"));
				await graph.addEdge("a", "b", "calls");

				expect(await graph.edgesFrom("a")).toEqual(["b"]);
				expect(await graph.edgesTo("b")).toEqual(["a"]);
				expect(await graph.edgesFrom("b")).toEqual([]);
				expect(await graph.edgesTo("a")).toEqual([]);
			}));

		it("filters edges by kind when asked, and two different kinds between the same pair coexist", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				await graph.addNode(node("b", "b"));
				await graph.addEdge("a", "b", "calls");
				await graph.addEdge("a", "b", "references");

				expect(await graph.edgesFrom("a", "calls")).toEqual(["b"]);
				expect(await graph.edgesFrom("a", "references")).toEqual(["b"]);
				expect(await graph.edgesFrom("a", "contains")).toEqual([]);
				expect(Array.from(await graph.edgesFrom("a")).sort()).toEqual(["b", "b"].sort());
			}));

		it("adding the same edge twice does not duplicate it", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				await graph.addNode(node("b", "b"));
				await graph.addEdge("a", "b", "calls");
				await graph.addEdge("a", "b", "calls");

				expect(await graph.edgesFrom("a", "calls")).toEqual(["b"]);
			}));

		it("reachableFrom finds multi-hop targets within maxDepth, excluding the start node itself", () =>
			withGraph(async (graph) => {
				// a -> b -> c -> d
				for (const id of ["a", "b", "c", "d"]) await graph.addNode(node(id, id));
				await graph.addEdge("a", "b", "calls");
				await graph.addEdge("b", "c", "calls");
				await graph.addEdge("c", "d", "calls");

				expect(Array.from(await graph.reachableFrom("a", { maxDepth: 1 })).sort()).toEqual(["b"]);
				expect(Array.from(await graph.reachableFrom("a", { maxDepth: 2 })).sort()).toEqual(["b", "c"]);
				expect(Array.from(await graph.reachableFrom("a", { maxDepth: 10 })).sort()).toEqual(["b", "c", "d"]);
				expect(await graph.reachableFrom("a", { maxDepth: 10 })).not.toContain("a");
			}));

		it("reachableFrom respects an edge-kind filter", () =>
			withGraph(async (graph) => {
				// a -[calls]-> b -[contains]-> c
				for (const id of ["a", "b", "c"]) await graph.addNode(node(id, id));
				await graph.addEdge("a", "b", "calls");
				await graph.addEdge("b", "c", "contains");

				expect(await graph.reachableFrom("a", { maxDepth: 10, kind: "calls" })).toEqual(["b"]);
				expect(await graph.reachableFrom("a", { maxDepth: 10 })).toContain("c");
			}));

		it("reachableFrom does not loop forever or return duplicates when the graph has a real cycle", () =>
			withGraph(async (graph) => {
				// a -> b -> a (mutual recursion)
				await graph.addNode(node("a", "a"));
				await graph.addNode(node("b", "b"));
				await graph.addEdge("a", "b", "calls");
				await graph.addEdge("b", "a", "calls");

				const reached = await graph.reachableFrom("a", { maxDepth: 10 });
				expect(reached).toEqual(["b"]);
			}));

		it("reachableFrom returns nothing for maxDepth 0 or less", () =>
			withGraph(async (graph) => {
				await graph.addNode(node("a", "a"));
				await graph.addNode(node("b", "b"));
				await graph.addEdge("a", "b", "calls");

				expect(await graph.reachableFrom("a", { maxDepth: 0 })).toEqual([]);
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
				await graph.addEdge("a", "b", "calls");

				const nodes = await graph.allNodes(10);
				expect(nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
				const edges = await graph.allEdges(10);
				expect(edges).toEqual([{ from: "a", to: "b", kind: "calls" }]);
			}));

		it("allNodes/allEdges are bounded by maxNodes/maxEdges", () =>
			withGraph(async (graph) => {
				for (const id of ["a", "b", "c"]) await graph.addNode(node(id, id));
				await graph.addEdge("a", "b", "calls");
				await graph.addEdge("b", "c", "calls");

				expect((await graph.allNodes(2)).length).toBe(2);
				expect((await graph.allEdges(1)).length).toBe(1);
			}));

		it("allNodes/allEdges return empty arrays for a graph with nothing added, not an error", () =>
			withGraph(async (graph) => {
				expect(await graph.allNodes(10)).toEqual([]);
				expect(await graph.allEdges(10)).toEqual([]);
			}));

		it("does not let edges/nodes touching one graph affect a separately created one", () =>
			withGraph(async (graphA) => {
				await withGraph(async (graphB) => {
					await graphA.addNode(node("a", "a"));
					await graphA.addNode(node("b", "b"));
					await graphA.addEdge("a", "b", "calls");

					expect(await graphB.getNode("a")).toBeUndefined();
					expect(await graphB.edgesFrom("a")).toEqual([]);
				});
			}));
	});
}
