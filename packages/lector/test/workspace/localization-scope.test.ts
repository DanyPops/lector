import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";
import { deriveSymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";
import type { TextSearchPort } from "../../src/text-search/port.ts";
import { InMemoryWorkspace } from "../../src/workspace/in-memory-workspace.ts";
import { LocalFilesystemWorkspace } from "../../src/workspace/local-filesystem-workspace.ts";
import { localizeContext } from "../../src/workspace/localize-context.ts";
import { recordLocalizationGeneration } from "../helpers/localization-generation.ts";

class RootedWorkspace extends InMemoryWorkspace {
	constructor(readonly root: string) {
		super();
	}
	override resolvePath(path: string): string {
		return resolve(this.root, path);
	}
}
const OPTIONS = { maxSymbols: 20, maxBytes: 30000, maxDepth: 2, maxGraphNodes: 100, maxLexicalMatches: 100, deadlineMs: 5000 };
const search: TextSearchPort = { search: async () => ({ matches: [], truncated: false }), findFiles: async () => ({ paths: [], truncated: false }) };
async function add(workspace: RootedWorkspace, graph: InMemorySymbolGraph, path: string, name: string) {
	const absolute = workspace.resolvePath(path);
	await workspace.writeEntry(absolute, null, `export function ${name}() {}`);
	const id = deriveSymbolNodeId({ path: absolute, line: 1, character: 1 });
	await graph.addNode({ id, name, kind: "function", location: { path: absolute, line: 1, character: 1 } });
	return id;
}

describe("localization workspace scope", () => {
	it("ignores machine prefixes and returns relative paths", async () => {
		const workspace = new RootedWorkspace("/machine/Projects/project-one");
		const graph = new InMemorySymbolGraph();
		await add(workspace, graph, "src/plain.ts", "utility");
		await recordLocalizationGeneration(workspace, graph);
		expect((await localizeContext("project", workspace, search, graph, OPTIONS)).candidates).toEqual([]);
		const result = await localizeContext("utility", workspace, search, graph, OPTIONS);
		expect(result.candidates[0]?.path).toBe("src/plain.ts");
		expect(JSON.stringify(result)).not.toContain("/machine");
	});

	it("filters dependencies before applying graph bounds", async () => {
		const workspace = new RootedWorkspace("/workspace/game");
		const graph = new InMemorySymbolGraph();
		for (let i = 0; i < 160; i++) await add(workspace, graph, `node_modules/sdk/${i}.ts`, `cacheDependency${i}`);
		const own = await add(workspace, graph, "src/cache.ts", "cacheOwner");
		const external = await add(workspace, graph, "../sibling/cache.ts", "cacheExternal");
		await graph.addEdge(own, external, "calls");
		await graph.addEdge(own, deriveSymbolNodeId({ path: workspace.resolvePath("node_modules/sdk/0.ts"), line: 1, character: 1 }), "calls");
		await recordLocalizationGeneration(workspace, graph);
		const result = await localizeContext("cache", workspace, search, graph, {
			...OPTIONS,
			seedSymbols: ["cacheDependency0", "cacheExternal"],
			seedLocations: [{ path: "../sibling/cache.ts", line: 1 }],
		});
		expect(result.candidates.map((candidate) => candidate.name)).toEqual(["cacheOwner"]);
		expect(result.candidates[0]?.path).toBe("src/cache.ts");
	});

	it("reports lexical truncation and retains graph evidence", async () => {
		const workspace = new RootedWorkspace("/workspace/game");
		const graph = new InMemorySymbolGraph();
		await add(workspace, graph, "src/render.ts", "renderGate");
		await workspace.writeEntry(workspace.resolvePath("bun.lock"), null, "gate\n".repeat(100));
		await recordLocalizationGeneration(workspace, graph);
		const boundedSearch: TextSearchPort = {
			findFiles: search.findFiles,
			search: async (_root, _query, bounds) => ({
				matches: Array.from({ length: Math.min(100, bounds.maxMatches) }, (_, i) => ({
					path: "bun.lock",
					lineNumber: i + 1,
					line: "gate",
					matchStart: 0,
					matchEnd: 4,
				})),
				truncated: true,
			}),
		};
		const lexicalOnly = await localizeContext("gate", workspace, boundedSearch, new InMemorySymbolGraph(), OPTIONS);
		expect(lexicalOnly.candidates.map((candidate) => candidate.path)).toEqual(["bun.lock"]);
		expect(lexicalOnly.candidates[0]?.role).toBe("configuration");
		const ranked = await localizeContext("gate", workspace, boundedSearch, graph, OPTIONS);
		expect(ranked.candidates[0]?.name).toBe("renderGate");
		expect(ranked.completeness.lexical).toBe("truncated");
	});

	it("rejects escaped symlinks and accepts owned targets", async () => {
		const directory = await mkdtemp(join(tmpdir(), "lector-scope-"));
		try {
			const root = join(directory, "project");
			await mkdir(join(root, "node_modules", "sdk"), { recursive: true });
			const cases = [
				["escaped.ts", join(directory, "outside.ts"), "cacheEscaped"],
				["dependency.ts", join(root, "node_modules", "sdk", "source.ts"), "cacheDependency"],
				["owned.ts", join(root, "source.ts"), "cacheOwned"],
			] as const;
			const graph = new InMemorySymbolGraph();
			for (const [alias, target, name] of cases) {
				await writeFile(target, `export function ${name}() {}`);
				const path = join(root, alias);
				await symlink(target, path);
				const location = { path, line: 1, character: 1 };
				await graph.addNode({ id: deriveSymbolNodeId(location), name, kind: "function", location });
			}
			const workspace = new LocalFilesystemWorkspace(root);
			await recordLocalizationGeneration(workspace, graph);
			const result = await localizeContext("cache", workspace, search, graph, OPTIONS);
			expect(result.candidates.map((candidate) => candidate.name)).toEqual(["cacheOwned"]);
			expect(result.candidates[0]?.path).toBe("owned.ts");
			expect(JSON.stringify(result)).not.toContain(directory);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("requires a separately scoped dependency workspace", async () => {
		const workspace = new RootedWorkspace("/workspace/game/node_modules/sdk");
		const graph = new InMemorySymbolGraph();
		await add(workspace, graph, "src/cache.ts", "cacheDependency");
		await recordLocalizationGeneration(workspace, graph);
		const result = await localizeContext("cache", workspace, search, graph, OPTIONS);
		expect(result.candidates[0]?.path).toBe("src/cache.ts");
		expect(result.candidates[0]?.name).toBe("cacheDependency");
	});
});
