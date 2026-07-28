/**
 * SqliteSymbolGraph was exported from the public barrel with zero tests --
 * a real gap, since it's the only SymbolGraphPort adapter that survives a
 * daemon restart. The conformance suite proves correctness (including its
 * WITH RECURSIVE reachableFrom, a real correctness risk InMemorySymbolGraph's
 * plain BFS doesn't share); the durability test below proves the actual
 * point of a SQLite-backed graph over the in-memory one.
 */
import { Database } from "bun:sqlite";
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

	it("keeps every polyglot generation source after reopen", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lector-sqlite-symbol-graph-sources-"));
		const dbPath = join(dir, "symbol-graph.db");
		const sources = [
			{ fidelity: "semantic", backend: "gopls", languageId: "go", authority: "language-server", freshness: "live-process", limitations: [] },
			{ fidelity: "semantic", backend: "pyright", languageId: "python", authority: "language-server", freshness: "live-process", limitations: [] },
		] as const;
		try {
			const first = new SqliteSymbolGraph(dbPath);
			await first.setGeneration({
				sourceFingerprint: "polyglot",
				maxFiles: 10,
				maxSymbolsPerFile: 20,
				completedAt: 1,
				provenance: {
					fidelity: "semantic",
					backend: "polyglot-language-servers",
					languageId: "polyglot",
					authority: "language-server",
					freshness: "live-process",
					limitations: [],
				},
				sources,
				result: {
					completeness: "partial",
					filesAttempted: 3,
					filesProcessed: 2,
					filesFailed: 1,
					symbolsProcessed: 2,
					nodesAdded: 2,
					edgesAdded: 0,
					failureCount: 1,
					failures: [
						{
							path: "/repo/excluded_test.go",
							operation: "document-symbols",
							code: "CodeIntelligenceFileError",
							message: "no package metadata",
							provenance: sources[0],
						},
					],
					failuresTruncated: false,
				},
			});
			await first.close();

			const second = new SqliteSymbolGraph(dbPath);
			try {
				const generation = await second.getGeneration();
				expect(generation?.sources).toEqual(sources);
				expect(generation?.result).toMatchObject({ completeness: "partial", filesFailed: 1, failureCount: 1 });
			} finally {
				await second.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads pre-v5 generation rows as complete after the result JSON migration", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lector-sqlite-symbol-graph-legacy-result-"));
		const dbPath = join(dir, "symbol-graph.db");
		try {
			const migrated = new SqliteSymbolGraph(dbPath);
			await migrated.close();
			const db = new Database(dbPath);
			db.query(
				"INSERT INTO symbol_graph_generation (singleton, source_fingerprint, max_files, max_symbols_per_file, completed_at, files_processed, symbols_processed, nodes_added, edges_added) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run("legacy", 10, 20, 1, 2, 3, 3, 1);
			db.close();

			const reopened = new SqliteSymbolGraph(dbPath);
			try {
				expect((await reopened.getGeneration())?.result).toEqual({
					completeness: "complete",
					filesAttempted: 2,
					filesProcessed: 2,
					filesFailed: 0,
					symbolsProcessed: 3,
					nodesAdded: 3,
					edgesAdded: 1,
					failureCount: 0,
					failures: [],
					failuresTruncated: false,
				});
			} finally {
				await reopened.close();
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

	it("keeps walkedFiles after reopen, and removeNodesForFile survives a real reopen too", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lector-sqlite-symbol-graph-walked-files-"));
		const dbPath = join(dir, "symbol-graph.db");
		try {
			const first = new SqliteSymbolGraph(dbPath);
			await first.addNode({ id: "a", name: "a", kind: "function", location: { path: "/src/a.ts", line: 1, character: 1 } });
			await first.addNode({ id: "b", name: "b", kind: "function", location: { path: "/src/deleted.ts", line: 1, character: 1 } });
			await first.addEdge("a", "b", "calls");
			await first.setGeneration({
				sourceFingerprint: "gen1",
				maxFiles: 10,
				maxSymbolsPerFile: 20,
				completedAt: 1,
				walkedFiles: ["/src/a.ts", "/src/deleted.ts"],
				result: {
					completeness: "complete",
					filesAttempted: 2,
					filesProcessed: 2,
					filesFailed: 0,
					symbolsProcessed: 2,
					nodesAdded: 2,
					edgesAdded: 1,
					failureCount: 0,
					failures: [],
					failuresTruncated: false,
				},
			});
			await first.close();

			const second = new SqliteSymbolGraph(dbPath);
			try {
				expect((await second.getGeneration())?.walkedFiles).toEqual(["/src/a.ts", "/src/deleted.ts"]);

				// The behavior walkedFiles exists to drive: purging a file that disappeared, surviving
				// the exact process restart a SQLite-backed graph is for.
				await second.removeNodesForFile("/src/deleted.ts");
				expect(await second.getNode("b")).toBeUndefined();
				expect(await second.getNode("a")).toBeDefined();
				expect(await second.edgesFrom("a")).toEqual([]);
			} finally {
				await second.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
