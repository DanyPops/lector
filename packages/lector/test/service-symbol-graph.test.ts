/**
 * Service-level wiring for the symbol-graph operations: workspace.populateSymbolGraph
 * actually walks real files through the real warm LSP index findSymbols already keeps
 * alive, and workspace.reachableFrom answers a real multi-hop question against the
 * resulting graph. Full domain-level correctness (the actual "calls"/"contains" edge
 * shapes) is already covered directly in test/populate-symbol-graph.test.ts; this file
 * only proves the service dispatch, workspace resolution, and per-workspace graph
 * lifecycle are wired correctly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/adapters/lsp/lsp-symbol-index.ts";
import { createLectorService, type LectorService } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-service-symbol-graph-"));
	mkdirSync(join(root, "src"));
	writeFileSync(
		join(root, "src", "chain.ts"),
		"export function a(): number {\n\treturn b();\n}\n\nexport function b(): number {\n\treturn c();\n}\n\nexport function c(): number {\n\treturn 42;\n}\n",
	);
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	return root;
}

describe("createLectorService's symbol-graph operations", () => {
	it("populateSymbolGraph walks real files, and reachableFrom answers a real multi-hop question against the result", async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		// Warms the index with a seed file first, matching how every other Tier A/B operation warms it.
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "a", seedFile: "src/chain.ts" });

		const populateResult = await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });
		expect(populateResult.filesProcessed).toBeGreaterThan(0);
		expect(populateResult.edgesAdded).toBeGreaterThan(0);

		const chainFile = join(fixtureRoot, "src", "chain.ts");
		const at = { workspaceId, path: chainFile, line: 1, character: 17 }; // "a" in "export function a"

		const oneHop = await service.dispatch("workspace.reachableFrom", { ...at, maxDepth: 1, kind: "calls" });
		const twoHops = await service.dispatch("workspace.reachableFrom", { ...at, maxDepth: 2, kind: "calls" });

		expect(oneHop.symbols.map((s) => s.name)).toContain("b");
		expect(oneHop.symbols.map((s) => s.name)).not.toContain("c");
		expect(twoHops.symbols.map((s) => s.name)).toContain("b");
		expect(twoHops.symbols.map((s) => s.name)).toContain("c");
	}, 20_000);

	it("symbolEdgesFrom/symbolEdgesTo answer direct one-hop questions after population", async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "a", seedFile: "src/chain.ts" });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });

		const chainFile = join(fixtureRoot, "src", "chain.ts");
		const aAt = { workspaceId, path: chainFile, line: 1, character: 17 };
		const bAt = { workspaceId, path: chainFile, line: 5, character: 17 }; // line 4 is the blank separator line

		const fromA = await service.dispatch("workspace.symbolEdgesFrom", { ...aAt, kind: "calls" });
		const toB = await service.dispatch("workspace.symbolEdgesTo", { ...bAt, kind: "calls" });

		expect(fromA.symbols.map((s) => s.name)).toContain("b");
		expect(toB.symbols.map((s) => s.name)).toContain("a");
	}, 20_000);

	it("reachableFrom against a never-populated workspace returns an honest empty result, not an error", async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const result = await service.dispatch("workspace.reachableFrom", {
			workspaceId,
			path: join(fixtureRoot, "src", "chain.ts"),
			line: 1,
			character: 17,
			maxDepth: 2,
		});

		expect(result.symbols).toEqual([]);
	}, 20_000);
});
