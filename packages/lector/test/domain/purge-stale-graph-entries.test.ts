import { describe, expect, it } from "bun:test";
import { InMemorySymbolGraph } from "../../src/adapters/in-memory-symbol-graph.ts";
import { purgeFilesNoLongerWalked } from "../../src/domain/purge-stale-graph-entries.ts";
import type { SymbolNode } from "../../src/ports/symbol-graph-port.ts";

function node(id: string, path: string): SymbolNode {
	return { id, name: id, kind: "function", location: { path, line: 1, character: 1 } };
}

describe("purgeFilesNoLongerWalked", () => {
	it("does nothing on the first-ever generation, when there is no previous walked-file list", async () => {
		const graph = new InMemorySymbolGraph();
		await graph.addNode(node("a", "/src/a.ts"));
		const purged = await purgeFilesNoLongerWalked(graph, undefined, ["/src/a.ts"]);
		expect(purged).toEqual([]);
		expect(await graph.getNode("a")).toBeDefined();
	});

	it("purges a file that was walked previously but is absent from the current walk", async () => {
		const graph = new InMemorySymbolGraph();
		await graph.addNode(node("a", "/src/deleted.ts"));
		const purged = await purgeFilesNoLongerWalked(graph, ["/src/deleted.ts", "/src/kept.ts"], ["/src/kept.ts"]);
		expect(purged).toEqual(["/src/deleted.ts"]);
		expect(await graph.getNode("a")).toBeUndefined();
	});

	it("never purges a path that was not part of the previous walked-file list, even if absent from the current one", async () => {
		// A callee node resolved outside the workspace's own source set (e.g. a system header or a
		// dependency) -- never directly walked, so its absence from currentFiles must not be read
		// as "this file was deleted".
		const graph = new InMemorySymbolGraph();
		await graph.addNode(node("external", "/usr/include/stdio.h"));
		const purged = await purgeFilesNoLongerWalked(graph, ["/src/kept.ts"], ["/src/kept.ts"]);
		expect(purged).toEqual([]);
		expect(await graph.getNode("external")).toBeDefined();
	});

	it("keeps a file present in both the previous and current walk", async () => {
		const graph = new InMemorySymbolGraph();
		await graph.addNode(node("a", "/src/kept.ts"));
		const purged = await purgeFilesNoLongerWalked(graph, ["/src/kept.ts"], ["/src/kept.ts"]);
		expect(purged).toEqual([]);
		expect(await graph.getNode("a")).toBeDefined();
	});
});
