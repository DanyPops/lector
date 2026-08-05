/**
 * workspace.hasWarmIndex exists so a caller deciding whether to enrich a
 * result with LSP-backed info (e.g. a post-edit diagnostics hint) can check
 * without paying a cold-start cost -- it must never itself cause a spawn.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { createLectorService, type LectorService, UnknownWorkspace } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-has-warm-index-fixture-"));
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	writeFileSync(join(root, "index.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	return root;
}

describe("workspace.hasWarmIndex", () => {
	it("reports false before any symbol query, and true once findSymbols has warmed the index -- without hasWarmIndex itself causing a spawn", async () => {
		fixtureRoot = buildFixture();
		let spawnCount = 0;
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => {
				spawnCount++;
				return new LspSymbolIndex(rootPath, descriptor, seedFile);
			},
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const beforeWarm = await service.dispatch("workspace.hasWarmIndex", { workspaceId });
		expect(beforeWarm.warm).toBe(false);
		expect(spawnCount).toBe(0);

		await service.dispatch("workspace.findSymbols", { workspaceId, query: "add", seedFile: "index.ts" });

		const afterWarm = await service.dispatch("workspace.hasWarmIndex", { workspaceId });
		expect(afterWarm.warm).toBe(true);
		expect(spawnCount).toBe(1);
	}, 20_000);

	it("rejects an unknown workspaceId rather than silently reporting not-warm", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("workspace.hasWarmIndex", { workspaceId: "never-registered" })).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it('with a path, checks that file\'s own language specifically -- not just "is anything warm for this workspace"', async () => {
		fixtureRoot = buildFixture();
		writeFileSync(join(fixtureRoot, "main.py"), "def add(a, b):\n    return a + b\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		await service.dispatch("workspace.documentSymbols", { workspaceId, path: join(fixtureRoot, "index.ts") });

		expect((await service.dispatch("workspace.hasWarmIndex", { workspaceId, path: join(fixtureRoot, "index.ts") })).warm).toBe(true);
		expect((await service.dispatch("workspace.hasWarmIndex", { workspaceId, path: join(fixtureRoot, "main.py") })).warm).toBe(false);
	}, 20_000);

	it("reports not-warm, not an error, for a path whose extension matches no known language", async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		expect((await service.dispatch("workspace.hasWarmIndex", { workspaceId, path: join(fixtureRoot, "README.md") })).warm).toBe(false);
	});
});
