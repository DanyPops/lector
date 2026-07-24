/**
 * SqliteSymbolGraph was exported from the public barrel with zero tests --
 * a real gap, since it's the only SymbolGraphPort adapter that survives a
 * daemon restart. The conformance suite proves correctness (including its
 * WITH RECURSIVE reachableFrom, a real correctness risk InMemorySymbolGraph's
 * plain BFS doesn't share); the durability test below proves the actual
 * point of a SQLite-backed graph over the in-memory one.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSymbolGraph } from "../../src/adapters/sqlite-symbol-graph.ts";
import { runSymbolGraphPortConformanceSuite } from "../support/symbol-graph-port-conformance.ts";

runSymbolGraphPortConformanceSuite("SqliteSymbolGraph", {
	createGraph: () => new SqliteSymbolGraph(":memory:"),
	cleanup: (graph) => (graph as SqliteSymbolGraph).close(),
});

describe("SqliteSymbolGraph durability", () => {
	it("keeps written nodes and edges after the writing instance is closed and a fresh one opens the same file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lector-sqlite-symbol-graph-durability-"));
		const dbPath = join(dir, "symbol-graph.db");
		try {
			const first = new SqliteSymbolGraph(dbPath);
			await first.addNode({ id: "a", name: "handleRequest", kind: "function", location: { path: "/src/a.ts", line: 1, character: 1 } });
			await first.addNode({ id: "b", name: "validate", kind: "function", location: { path: "/src/b.ts", line: 3, character: 1 } });
			await first.addEdge("a", "b", "calls");
			await first.close();

			const second = new SqliteSymbolGraph(dbPath);
			try {
				expect(await second.getNode("a")).toEqual({ id: "a", name: "handleRequest", kind: "function", location: { path: "/src/a.ts", line: 1, character: 1 } });
				expect(await second.edgesFrom("a", "calls")).toEqual(["b"]);
			} finally {
				await second.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reachableFrom's WITH RECURSIVE query respects maxDepth across a real reopen, not just in-process state", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lector-sqlite-symbol-graph-recursive-"));
		const dbPath = join(dir, "symbol-graph.db");
		try {
			const first = new SqliteSymbolGraph(dbPath);
			// a -> b -> c -> d
			for (const id of ["a", "b", "c", "d"]) await first.addNode({ id, name: id, kind: "function", location: { path: "/src/x.ts", line: 1, character: 1 } });
			await first.addEdge("a", "b", "calls");
			await first.addEdge("b", "c", "calls");
			await first.addEdge("c", "d", "calls");
			await first.close();

			const second = new SqliteSymbolGraph(dbPath);
			try {
				expect(Array.from(await second.reachableFrom("a", { maxDepth: 1 })).sort()).toEqual(["b"]);
				expect(Array.from(await second.reachableFrom("a", { maxDepth: 3 })).sort()).toEqual(["b", "c", "d"]);
			} finally {
				await second.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
