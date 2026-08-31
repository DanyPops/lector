import { describe, expect, it } from "bun:test";
import { changedSymbolImpact } from "../../src/code-intelligence/impact-analysis.ts";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";
import { deriveSymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";

const location = (path: string, line: number) => ({ path, line, character: 1 });
const node = (name: string, path: string, line: number) => ({
	id: deriveSymbolNodeId(location(path, line)),
	name,
	kind: "function",
	location: location(path, line),
});

describe("changedSymbolImpact", () => {
	it("maps changed ranges to declarations and returns a deterministic reverse impact cone", async () => {
		const graph = new InMemorySymbolGraph();
		const changed = node("calculate", "/repo/src/calculate.ts", 10);
		const caller = node("checkout", "/repo/src/checkout.ts", 20);
		const test = node("checkout test", "/repo/test/checkout.test.ts", 5);
		const unrelatedTest = node("profile test", "/repo/test/profile.test.ts", 5);
		for (const symbol of [changed, caller, test, unrelatedTest]) await graph.addNode(symbol);
		await graph.addEdge(caller.id, changed.id, "calls");
		await graph.addEdge(test.id, caller.id, "calls");

		const result = await changedSymbolImpact(
			graph,
			[
				{
					path: "src/calculate.ts",
					status: "modified",
					binary: false,
					hunks: [{ oldStart: 11, oldLines: 1, newStart: 11, newLines: 1, header: "", lines: ["-old", "+new"] }],
				},
			],
			{ rootPath: "/repo", maxDepth: 2, maxNodes: 10, maxEdges: 100, deadlineMs: 1_000 },
		);

		expect(result.changedSymbols.map(({ symbol }) => symbol.name)).toEqual(["calculate"]);
		expect(result.impactedSymbols.map(({ symbol, depth }) => [symbol.name, depth])).toEqual([
			["checkout", 1],
			["checkout test", 2],
		]);
		expect(result.relatedTests).toEqual([
			expect.objectContaining({ symbol: expect.objectContaining({ name: "checkout test" }), evidence: { kind: "semantic-edge", depth: 2 } }),
		]);
		// The selected test is the seeded regression-catching test, while the unrelated test is skipped.
		expect(result.relatedTests.length).toBeLessThan([test, unrelatedTest].length);
		await graph.close();
	});

	it("maps changed declarations across Go and Python files deterministically", async () => {
		const graph = new InMemorySymbolGraph();
		const goSymbol = node("Process", "/repo/go/process.go", 4);
		const pythonSymbol = node("transform", "/repo/python/transform.py", 7);
		await graph.addNode(goSymbol);
		await graph.addNode(pythonSymbol);
		const result = await changedSymbolImpact(
			graph,
			[
				{ path: "go/process.go", status: "modified", binary: false, hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, header: "", lines: [] }] },
				{
					path: "python/transform.py",
					status: "modified",
					binary: false,
					hunks: [{ oldStart: 8, oldLines: 1, newStart: 8, newLines: 1, header: "", lines: [] }],
				},
			],
			{ rootPath: "/repo", maxDepth: 1, maxNodes: 10, maxEdges: 100, deadlineMs: 1_000 },
		);
		expect(result.changedSymbols.map(({ symbol }) => symbol.name)).toEqual(["Process", "transform"]);
		await graph.close();
	});

	it("reports renamed and deleted paths as before-side evidence", async () => {
		const graph = new InMemorySymbolGraph();
		const removed = node("legacy", "/repo/src/legacy.ts", 3);
		await graph.addNode(removed);
		const result = await changedSymbolImpact(graph, [{ path: "src/new.ts", previousPath: "src/legacy.ts", status: "renamed", binary: false, hunks: [] }], {
			rootPath: "/repo",
			maxDepth: 1,
			maxNodes: 10,
			maxEdges: 100,
			deadlineMs: 1_000,
		});
		expect(result.changedSymbols).toEqual([expect.objectContaining({ side: "before", symbol: expect.objectContaining({ name: "legacy" }) })]);
		await graph.close();
	});
});
