import { describe, expect, it, spyOn } from "bun:test";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { InMemorySymbolAnnotations } from "../../src/symbol-annotation/in-memory-symbol-annotations.ts";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";
import { deriveSymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";
import type { TextSearchPort } from "../../src/text-search/port.ts";
import { InMemoryWorkspace } from "../../src/workspace/in-memory-workspace.ts";
import { localizeContext } from "../../src/workspace/localize-context.ts";
import { recordLocalizationGeneration } from "../helpers/localization-generation.ts";

function textSearch(matches: readonly { path: string; lineNumber: number; line: string; matchStart: number; matchEnd: number }[]): TextSearchPort {
	return {
		async search() {
			return { matches, truncated: false };
		},
		async findFiles() {
			return { paths: [], truncated: false };
		},
	};
}

async function node(graph: InMemorySymbolGraph, name: string, path: string, line: number) {
	const id = deriveSymbolNodeId({ path, line, character: 1 });
	await graph.addNode({ id, name, kind: "function", location: { path, line, character: 1 } });
	return id;
}

const OPTIONS = { maxSymbols: 20, maxBytes: 30_000, maxDepth: 2, maxGraphNodes: 200, maxLexicalMatches: 100, deadlineMs: 5_000 };

describe("localizeContext", () => {
	it("excludes deleted seeds and their expansion", async () => {
		const workspace = new InMemoryWorkspace();
		const source = "export function vanished() {}";
		await workspace.writeEntry("old.ts", null, source);
		await workspace.writeEntry("neighbor.ts", null, "export function neighbor() {}");
		const graph = new InMemorySymbolGraph();
		const seed = await node(graph, "vanished", "old.ts", 1);
		const neighbor = await node(graph, "neighbor", "neighbor.ts", 1);
		await graph.addEdge(seed, neighbor, "calls");
		await recordLocalizationGeneration(workspace, graph);
		await workspace.deleteEntry("old.ts", contentHashOf(source));
		const result = await localizeContext("vanished", workspace, textSearch([]), graph, { ...OPTIONS, seedSymbols: ["vanished"] });
		expect(result.candidates).toEqual([]);
		expect(result.truncated).toBe(true);
		expect(await graph.getNode(seed)).toBeDefined();
	});

	it.each(["deleted", "renamed", "drifted", "unreadable"])("excludes %s graph neighbors", async (change) => {
		const workspace = new InMemoryWorkspace();
		const source = "export function obsolete() {}";
		await workspace.writeEntry("old.ts", null, source);
		await workspace.writeEntry("entry.ts", null, "export function entry() {}");
		const graph = new InMemorySymbolGraph();
		const entry = await node(graph, "entry", "entry.ts", 1);
		const old = await node(graph, "obsolete", "old.ts", 1);
		await graph.addEdge(entry, old, "calls");
		await recordLocalizationGeneration(workspace, graph);
		if (change === "deleted") await workspace.deleteEntry("old.ts", contentHashOf(source));
		if (change === "renamed") await workspace.renamePath("old.ts", "new.ts");
		if (change === "drifted") await workspace.writeEntry("old.ts", contentHashOf(source), "export function replacement() {}");
		const read = workspace.readSourceSnapshot.bind(workspace);
		const spy = spyOn(workspace, "readSourceSnapshot").mockImplementation((path, bytes, signal) =>
			change === "unreadable" && path === "old.ts" ? Promise.resolve({ status: "unavailable", reason: "unreadable" }) : read(path, bytes, signal),
		);
		try {
			const result = await localizeContext("entry", workspace, textSearch([]), graph, OPTIONS);
			expect(result.candidates.map((candidate) => candidate.name)).toEqual(["entry"]);
			expect(result.completeness.graph).toBe("bounded");
			expect(result.truncated).toBe(true);
			expect(await graph.getNode(old)).toBeDefined();
		} finally {
			spy.mockRestore();
		}
	});

	it("bounds source checks and reuses each snapshot", async () => {
		const workspace = new InMemoryWorkspace();
		const graph = new InMemorySymbolGraph();
		for (let i = 0; i < 140; i++) {
			await workspace.writeEntry(`${i}.ts`, null, "export function cache() {}\nexport function cacheTwo() {}");
			await node(graph, "cache", `${i}.ts`, 1);
		}
		await node(graph, "cacheTwo", "0.ts", 2);
		await recordLocalizationGeneration(workspace, graph);
		const spy = spyOn(workspace, "readSourceSnapshot");
		try {
			const result = await localizeContext("cache", workspace, textSearch([]), graph, { ...OPTIONS, maxSymbols: 200, maxBytes: 200000 });
			expect(spy).toHaveBeenCalledTimes(128);
			expect(result.truncated).toBe(true);
			expect(result.candidates).toHaveLength(129);
		} finally {
			spy.mockRestore();
		}
	});

	it("stops source inspection at its deadline", async () => {
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("cache.ts", null, "export function cache() {}");
		const graph = new InMemorySymbolGraph();
		await node(graph, "cache", "cache.ts", 1);
		await recordLocalizationGeneration(workspace, graph);
		const spy = spyOn(workspace, "readSourceSnapshot").mockImplementation(
			(_path, _bytes, signal) =>
				new Promise((resolve) => {
					const aborted = () => resolve({ status: "unavailable", reason: "aborted" });
					if (signal.aborted) aborted();
					else signal.addEventListener("abort", aborted, { once: true });
				}),
		);
		try {
			const result = await localizeContext("cache", workspace, textSearch([]), graph, { ...OPTIONS, deadlineMs: 10 });
			expect(result.candidates).toEqual([]);
			expect(result.completeness.deadlineReached).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	it("excludes stale lexical matches", async () => {
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("cache.ts", null, "export const replacement = true");
		const result = await localizeContext(
			"cache",
			workspace,
			textSearch([{ path: "cache.ts", lineNumber: 1, line: "export const cache = true", matchStart: 13, matchEnd: 18 }]),
			new InMemorySymbolGraph(),
			OPTIONS,
		);
		expect(result.candidates).toEqual([]);
		expect(result.truncated).toBe(true);
	});

	it("excludes declarations without generation hashes", async () => {
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("cache.ts", null, "export function cache() {}");
		const graph = new InMemorySymbolGraph();
		await node(graph, "cache", "cache.ts", 1);
		const result = await localizeContext("cache", workspace, textSearch([]), graph, OPTIONS);
		expect(result.candidates).toEqual([]);
		expect(result.truncated).toBe(true);
	});

	it("combines lexical and symbol-name evidence, then explains direct graph expansion", async () => {
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("src/cache.ts", null, "export function activeCachingJobs() {}\nexport function PopulationProgressTracker() {}\n");
		await workspace.writeEntry("src/ui.ts", null, "export function CachingOverlay() {}\n");
		const graph = new InMemorySymbolGraph();
		const overlay = await node(graph, "CachingOverlay", "src/ui.ts", 1);
		const activeJobs = await node(graph, "activeCachingJobs", "src/cache.ts", 1);
		const progress = await node(graph, "PopulationProgressTracker", "src/cache.ts", 2);
		await graph.addEdge(overlay, activeJobs, "calls");
		await graph.addEdge(activeJobs, progress, "references");
		await graph.setGeneration({
			sourceFingerprint: "fixture",
			maxFiles: 2,
			maxSymbolsPerFile: 20,
			completedAt: 1,
			walkedFiles: ["src/cache.ts", "src/ui.ts"],
			result: {
				completeness: "complete",
				filesAttempted: 2,
				filesProcessed: 2,
				filesFailed: 0,
				symbolsProcessed: 3,
				nodesAdded: 3,
				edgesAdded: 2,
				failureCount: 0,
				failures: [],
				failuresTruncated: false,
			},
		});

		await recordLocalizationGeneration(workspace, graph);
		const result = await localizeContext(
			"Fix stale cache progress appearing in another Pi session",
			workspace,
			textSearch([{ path: "src/cache.ts", lineNumber: 2, line: "PopulationProgressTracker", matchStart: 0, matchEnd: 10 }]),
			graph,
			OPTIONS,
		);

		expect(result.candidates.map((candidate) => candidate.name)).toContain("CachingOverlay");
		expect(result.candidates.map((candidate) => candidate.name)).toContain("activeCachingJobs");
		expect(result.candidates.map((candidate) => candidate.name)).toContain("PopulationProgressTracker");
		expect(result.candidates.find((candidate) => candidate.name === "activeCachingJobs")?.reasons).toContainEqual(
			expect.objectContaining({ kind: "graph-edge", detail: expect.stringContaining("CachingOverlay -> activeCachingJobs") }),
		);
		expect(result.completeness).toEqual({ lexical: "complete", graph: "complete", deadlineReached: false, candidateLimitReached: false });
	});

	it("skips an oversized candidate and continues emitting later compact candidates within maxBytes", async () => {
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("huge.ts", null, `export function huge() { /* ${"x".repeat(10_000)} */ }\n`);
		await workspace.writeEntry("small.ts", null, "export function smallCache() {}\n");
		const graph = new InMemorySymbolGraph();
		await node(graph, "hugeCache", "huge.ts", 1);
		await node(graph, "smallCache", "small.ts", 1);
		await recordLocalizationGeneration(workspace, graph);

		const result = await localizeContext("cache", workspace, textSearch([]), graph, { ...OPTIONS, maxBytes: 500 });

		expect(result.candidates.some((candidate) => candidate.name === "smallCache")).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result.candidates), "utf8")).toBeLessThanOrEqual(500);
		expect(result.truncated).toBe(true);
	});

	it("uses matching symbol annotations as explicit, status-aware ranking evidence", async () => {
		const workspace = new InMemoryWorkspace();
		const content = "export function refreshCoordinator() {}\n";
		await workspace.writeEntry("refresh.ts", null, content);
		const graph = new InMemorySymbolGraph();
		const symbolNodeId = await node(graph, "refreshCoordinator", "refresh.ts", 1);
		const annotations = new InMemorySymbolAnnotations();
		await annotations.create({
			subtype: "architecture",
			title: "session cache progress ownership",
			body: "Scopes progress records to the active Pi session.",
			anchors: [{ symbolNodeId, path: "refresh.ts", fileContentHash: contentHashOf(content) }],
		});

		await recordLocalizationGeneration(workspace, graph);
		const result = await localizeContext("cache progress session", workspace, textSearch([]), graph, { ...OPTIONS, annotations });
		expect(result.candidates[0]?.name).toBe("refreshCoordinator");
		expect(result.candidates[0]?.reasons).toContainEqual(
			expect.objectContaining({ kind: "annotation", detail: expect.stringContaining("session cache progress ownership") }),
		);
	});

	it("returns lexical file candidates while reporting an unpopulated graph as unavailable", async () => {
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("config/cache.config.ts", null, "\n\nexport const progress = true");
		const result = await localizeContext(
			"cache progress",
			workspace,
			textSearch([{ path: "config/cache.config.ts", lineNumber: 3, line: "export const progress = true", matchStart: 13, matchEnd: 21 }]),
			new InMemorySymbolGraph(),
			OPTIONS,
		);
		expect(result.completeness.graph).toBe("unavailable");
		expect(result.candidates[0]).toEqual(expect.objectContaining({ kind: "file", role: "configuration", path: "config/cache.config.ts", line: 3 }));
	});
});
