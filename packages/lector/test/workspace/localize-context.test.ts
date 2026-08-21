import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { InMemorySymbolAnnotations } from "../../src/symbol-annotation/in-memory-symbol-annotations.ts";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";
import { deriveSymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";
import type { TextSearchPort } from "../../src/text-search/port.ts";
import { InMemoryWorkspace } from "../../src/workspace/in-memory-workspace.ts";
import { localizeContext } from "../../src/workspace/localize-context.ts";

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

		const result = await localizeContext("cache progress session", workspace, textSearch([]), graph, { ...OPTIONS, annotations });
		expect(result.candidates[0]?.name).toBe("refreshCoordinator");
		expect(result.candidates[0]?.reasons).toContainEqual(
			expect.objectContaining({ kind: "annotation", detail: expect.stringContaining("session cache progress ownership") }),
		);
	});

	it("returns lexical file candidates while reporting an unpopulated graph as unavailable", async () => {
		const result = await localizeContext(
			"cache progress",
			new InMemoryWorkspace(),
			textSearch([{ path: "config/cache.config.ts", lineNumber: 3, line: "export const progress = true", matchStart: 13, matchEnd: 21 }]),
			new InMemorySymbolGraph(),
			OPTIONS,
		);
		expect(result.completeness.graph).toBe("unavailable");
		expect(result.candidates[0]).toEqual(expect.objectContaining({ kind: "file", role: "configuration", path: "config/cache.config.ts", line: 3 }));
	});
});
