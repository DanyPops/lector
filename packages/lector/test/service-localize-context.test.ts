import { describe, expect, it } from "bun:test";
import { createLectorService } from "../src/service.ts";
import { InMemorySymbolGraph } from "../src/symbol-graph/in-memory-symbol-graph.ts";
import { deriveSymbolNodeId } from "../src/symbol-graph/symbol-node-id.ts";
import type { TextSearchPort } from "../src/text-search/port.ts";
import { InMemoryWorkspace } from "../src/workspace/in-memory-workspace.ts";

const noLexicalMatches: TextSearchPort = {
	async search() {
		return { matches: [], truncated: false };
	},
	async findFiles() {
		return { paths: [], truncated: false };
	},
};

describe("workspace.localizeContext", () => {
	it("dispatches an end-to-end bounded localization query through the service", async () => {
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("src/cache.ts", null, "export function activeCachingJobs() {}\n");
		const graph = new InMemorySymbolGraph();
		await graph.addNode({
			id: deriveSymbolNodeId({ path: "src/cache.ts", line: 1, character: 1 }),
			name: "activeCachingJobs",
			kind: "function",
			location: { path: "src/cache.ts", line: 1, character: 1 },
		});
		const service = createLectorService(new Map([["ws", workspace]]), {
			createTextSearch: () => noLexicalMatches,
			createSymbolGraph: () => graph,
		});
		try {
			const result = await service.dispatch("workspace.localizeContext", {
				workspaceId: "ws",
				query: "fix stale caching jobs",
				maxSymbols: 5,
				maxBytes: 10_000,
				maxDepth: 2,
			});
			expect(result.candidates[0]).toEqual(
				expect.objectContaining({ name: "activeCachingJobs", path: "src/cache.ts", signature: "export function activeCachingJobs() {}" }),
			);
			expect(service.operations).toContain("workspace.localizeContext");
		} finally {
			await service.close();
		}
	});

	it("rejects unbounded or empty requests at the service boundary", async () => {
		const service = createLectorService(new Map([["ws", new InMemoryWorkspace()]]), { createTextSearch: () => noLexicalMatches });
		try {
			await expect(service.dispatch("workspace.localizeContext", { workspaceId: "ws", query: "", maxSymbols: 5 })).rejects.toThrow(
				"query must be a non-empty string",
			);
			await expect(service.dispatch("workspace.localizeContext", { workspaceId: "ws", query: "cache", maxDepth: 100 })).rejects.toThrow(
				"maxDepth must be a positive safe integer no greater than 5",
			);
		} finally {
			await service.close();
		}
	});
});
