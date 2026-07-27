/**
 * Service-level wiring for workspace.map: a real LSP-populated graph gets
 * ranked and bounded correctly through the service dispatch. Domain-level
 * ranking/truncation correctness is already covered directly in
 * test/domain/workspace-map.test.ts; this file only proves the service
 * resolves the right workspace/graph and passes bounds through.
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
	const root = mkdtempSync(join(tmpdir(), "lector-service-workspace-map-"));
	mkdirSync(join(root, "src"));
	writeFileSync(
		join(root, "src", "chain.ts"),
		"export function central(): number {\n\treturn 1;\n}\n\nexport function a(): number {\n\treturn central();\n}\n\nexport function b(): number {\n\treturn central();\n}\n\nexport function c(): number {\n\treturn central();\n}\n",
	);
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	return root;
}

describe("createLectorService's workspace.map operation", () => {
	it("ranks a real LSP-populated graph, with the most-called symbol first", async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "central", seedFile: "src/chain.ts" });
		const populateResult = await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });
		expect(populateResult.nodesAdded).toBeGreaterThan(0);

		const map = await service.dispatch("workspace.map", { workspaceId, maxNodes: 1_000, maxEdges: 1_000, maxEntries: 100, maxBytes: 1_000_000 });
		expect(map.entries.length).toBeGreaterThan(0);
		expect(map.entries[0]?.name).toBe("central");
		expect(map.entries[0]?.signature).toContain("function central");
	});

	it("truncates to maxEntries through the service dispatch", async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "central", seedFile: "src/chain.ts" });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });

		const map = await service.dispatch("workspace.map", { workspaceId, maxNodes: 1_000, maxEdges: 1_000, maxEntries: 1, maxBytes: 1_000_000 });
		expect(map.entries).toHaveLength(1);
		expect(map.truncated).toBe(true);
	});

	it("returns an empty map for a workspace whose graph was never populated", async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const map = await service.dispatch("workspace.map", { workspaceId, maxNodes: 1_000, maxEdges: 1_000, maxEntries: 100, maxBytes: 1_000_000 });
		expect(map).toEqual({ entries: [], totalRanked: 0, truncated: false });
	});
});
