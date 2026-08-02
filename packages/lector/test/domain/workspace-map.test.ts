import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkspace } from "../../src/adapters/in-memory-workspace.ts";
import { LocalFilesystemWorkspace } from "../../src/adapters/local-filesystem-workspace.ts";
import { computeWorkspaceMap } from "../../src/domain/workspace-map.ts";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";

const DEFAULT_OPTIONS = { maxNodes: 1_000, maxEdges: 1_000, maxEntries: 100, maxBytes: 1_000_000 };

async function seedNode(graph: InMemorySymbolGraph, id: string, name: string, path: string, line = 1): Promise<void> {
	await graph.addNode({ id, name, kind: "function", location: { path, line, character: 1 } });
}

describe("computeWorkspaceMap", () => {
	it("returns an empty result for a graph with no nodes", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		const result = await computeWorkspaceMap(graph, workspace, DEFAULT_OPTIONS);
		expect(result).toEqual({ entries: [], totalRanked: 0, truncated: false });
	});

	it("ranks a symbol called by many others above an isolated leaf that nothing calls", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		await seedNode(graph, "central", "central", "a.ts", 1);
		await seedNode(graph, "leaf", "leaf", "a.ts", 2);
		for (const callerId of ["c1", "c2", "c3"]) {
			await seedNode(graph, callerId, callerId, "a.ts", 3);
			await graph.addEdge(callerId, "central", "calls");
		}

		const result = await computeWorkspaceMap(graph, workspace, DEFAULT_OPTIONS);
		const names = result.entries.map((e) => e.name);
		expect(names.indexOf("central")).toBeLessThan(names.indexOf("leaf"));
	});

	it("excludes a node_modules/vendored declaration from ranking, even though many domain call sites point at it", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		// A stdlib-shaped node reached only as an outgoingCalls edge target, never scanned directly --
		// exactly how lib.es5.d.ts's Array.push showed up in a real workspace map run.
		await seedNode(graph, "push", "push", "node_modules/typescript/lib/lib.es5.d.ts", 1347);
		await seedNode(graph, "domainCentral", "domainCentral", "a.ts", 1);
		await seedNode(graph, "domainLeaf", "domainLeaf", "a.ts", 2);
		for (const callerId of ["c1", "c2", "c3"]) {
			await seedNode(graph, callerId, callerId, "a.ts", 3);
			await graph.addEdge(callerId, "domainCentral", "calls");
			// Every caller also calls the same shared vendored method -- this is the exact pollution
			// pattern found live: many unrelated call sites converging on one stdlib declaration.
			await graph.addEdge(callerId, "push", "calls");
		}

		const result = await computeWorkspaceMap(graph, workspace, DEFAULT_OPTIONS);
		const names = result.entries.map((e) => e.name);
		expect(names).not.toContain("push");
		expect(names.indexOf("domainCentral")).toBeLessThan(names.indexOf("domainLeaf"));
	});

	it("attaches the real current source line as the signature", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("a.ts", null, "export function add() {}\nexport function sub() {}\n");
		await seedNode(graph, "add", "add", "a.ts", 1);

		const result = await computeWorkspaceMap(graph, workspace, DEFAULT_OPTIONS);
		expect(result.entries[0]?.signature).toBe("export function add() {}");
	});

	it("omits the signature (but still includes the entry) when the anchored file no longer exists", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		await seedNode(graph, "gone", "gone", "removed.ts", 1);

		const result = await computeWorkspaceMap(graph, workspace, DEFAULT_OPTIONS);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.signature).toBeUndefined();
	});

	it("omits the signature (but still includes the entry, and never throws) for a node whose path lives entirely outside the workspace root", async () => {
		// Reproduces a real failure found live: an outgoingCalls edge target resolved into a
		// non-npm ecosystem's stdlib (e.g. Rust's rustup toolchain source), an absolute path with
		// no node_modules-shaped segment for pathHasSkippedDirectorySegment to catch, and with a
		// LocalFilesystemWorkspace root, readEntry throws PathEscapesWorkspaceRoot rather than
		// reporting the file missing -- computeWorkspaceMap must not let that propagate uncaught.
		const root = mkdtempSync(join(tmpdir(), "lector-workspace-map-escape-"));
		try {
			const graph = new InMemorySymbolGraph();
			const workspace = new LocalFilesystemWorkspace(root);
			await seedNode(graph, "outside", "outside", "/definitely/outside/the/workspace/root.rs", 1);

			const result = await computeWorkspaceMap(graph, workspace, DEFAULT_OPTIONS);
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0]?.signature).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("truncates to maxEntries and reports totalRanked/truncated correctly", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		for (const id of ["a", "b", "c", "d"]) await seedNode(graph, id, id, "a.ts", 1);

		const result = await computeWorkspaceMap(graph, workspace, { ...DEFAULT_OPTIONS, maxEntries: 2 });
		expect(result.entries).toHaveLength(2);
		expect(result.totalRanked).toBe(4);
		expect(result.truncated).toBe(true);
	});

	it("does not report truncated when every ranked node fits", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		await seedNode(graph, "a", "a", "a.ts", 1);

		const result = await computeWorkspaceMap(graph, workspace, DEFAULT_OPTIONS);
		expect(result.truncated).toBe(false);
	});

	it("stops adding entries once maxBytes is exceeded, while always keeping at least the first entry", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		for (const id of ["a", "b", "c"]) await seedNode(graph, id, id, "a.ts", 1);

		const result = await computeWorkspaceMap(graph, workspace, { ...DEFAULT_OPTIONS, maxBytes: 1 });
		expect(result.entries.length).toBeGreaterThanOrEqual(1);
		expect(result.entries.length).toBeLessThan(3);
		expect(result.truncated).toBe(true);
	});

	it("skips an edge that references a node outside the bounded fetch, rather than fabricating one", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		await seedNode(graph, "a", "a", "a.ts", 1);
		await graph.addEdge("a", "outside-the-fetch", "calls");

		const result = await computeWorkspaceMap(graph, workspace, DEFAULT_OPTIONS);
		expect(result.entries.map((e) => e.name)).toEqual(["a"]);
	});

	it("reads a multiply-referenced file only once", async () => {
		const graph = new InMemorySymbolGraph();
		let reads = 0;
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("a.ts", null, "export function add() {}\nexport function sub() {}\n");
		const originalReadEntry = workspace.readEntry.bind(workspace);
		workspace.readEntry = async (path: string) => {
			reads++;
			return originalReadEntry(path);
		};
		await seedNode(graph, "add", "add", "a.ts", 1);
		await seedNode(graph, "sub", "sub", "a.ts", 2);

		await computeWorkspaceMap(graph, workspace, DEFAULT_OPTIONS);
		expect(reads).toBe(1);
	});
});
