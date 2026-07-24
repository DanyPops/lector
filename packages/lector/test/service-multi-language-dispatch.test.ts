/**
 * Every mainstream editor (VSCode, Neovim, Zed, Helix -- see the linked
 * research doc) dispatches per-file, by that file's own language, never by
 * guessing "the workspace's language." This proves createLectorService does
 * the same: a monoglot workspace auto-detects with no seedFile at all, and
 * a polyglot workspace holds one independent warm index per language
 * actually touched, with zero cross-contamination between them.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/adapters/lsp/lsp-symbol-index.ts";
import { createLectorService, type LectorService, UnsupportedLanguage } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildMonoglotPython(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-monoglot-py-"));
	writeFileSync(join(root, "main.py"), "def add(a: int, b: int) -> int:\n    return a + b\n");
	return root;
}

function buildMonoglotGo(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-monoglot-go-"));
	writeFileSync(join(root, "go.mod"), "module fixture\n\ngo 1.22\n");
	writeFileSync(join(root, "main.go"), "package main\n\nfunc add(a int, b int) int {\n\treturn a + b\n}\n");
	return root;
}

function buildPolyglot(): { root: string; tsFile: string; pyFile: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-polyglot-"));

	const tsRoot = join(root, "frontend");
	mkdirSync(tsRoot);
	writeFileSync(join(tsRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	const tsFile = join(tsRoot, "main.ts");
	writeFileSync(tsFile, "export function tsOnly(a: number, b: number): number {\n\treturn a + b;\n}\n");

	const pyRoot = join(root, "backend");
	mkdirSync(pyRoot);
	const pyFile = join(pyRoot, "main.py");
	writeFileSync(pyFile, "def python_only(a: int, b: int) -> int:\n    return a + b\n");

	return { root, tsFile, pyFile };
}

describe("multi-language dispatch: monoglot workspaces auto-detect with no seedFile at all", () => {
	it("a Python-only workspace auto-detects Python -- findSymbols with no seedFile, and documentSymbols on a .py file, both work with zero manual language selection", async () => {
		fixtureRoot = buildMonoglotPython();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const { symbols: found } = await service.dispatch("workspace.findSymbols", { workspaceId, query: "add" });
		expect(found.find((s) => s.name === "add")).toBeDefined();

		const { symbols: declared } = await service.dispatch("workspace.documentSymbols", { workspaceId, path: join(fixtureRoot, "main.py") });
		expect(declared.find((s) => s.name === "add")).toBeDefined();
	}, 20_000);

	it("a Go-only workspace auto-detects Go -- findSymbols with no seedFile at all", async () => {
		fixtureRoot = buildMonoglotGo();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const { symbols } = await service.dispatch("workspace.findSymbols", { workspaceId, query: "add" });
		expect(symbols.find((s) => s.name === "add")).toBeDefined();
	}, 20_000);

	it("rejects with UnsupportedLanguage, not a silent TypeScript default, for a workspace with no source files Lector knows about", async () => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "lector-unsupported-"));
		writeFileSync(join(fixtureRoot, "README.md"), "# nothing but docs\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		await expect(service.dispatch("workspace.findSymbols", { workspaceId, query: "anything" })).rejects.toBeInstanceOf(UnsupportedLanguage);
	});
});

describe("multi-language dispatch: a polyglot workspace holds one independent warm index per language", () => {
	it("a TypeScript file and a Python file in the same workspace each resolve through their own correct language, automatically, from path alone", async () => {
		const { root, tsFile, pyFile } = buildPolyglot();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const { symbols: tsSymbols } = await service.dispatch("workspace.documentSymbols", { workspaceId, path: tsFile });
		const { symbols: pySymbols } = await service.dispatch("workspace.documentSymbols", { workspaceId, path: pyFile });

		expect(tsSymbols.map((s) => s.name)).toContain("tsOnly");
		expect(pySymbols.map((s) => s.name)).toContain("python_only");
		// No cross-contamination: neither server ever saw the other language's symbol.
		expect(tsSymbols.map((s) => s.name)).not.toContain("python_only");
		expect(pySymbols.map((s) => s.name)).not.toContain("tsOnly");
	}, 30_000);

	it("hasWarmIndex distinguishes per-language warmth within the same workspace, not just per-workspace", async () => {
		const { root, tsFile, pyFile } = buildPolyglot();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await service.dispatch("workspace.documentSymbols", { workspaceId, path: tsFile });

		expect((await service.dispatch("workspace.hasWarmIndex", { workspaceId, path: tsFile })).warm).toBe(true);
		expect((await service.dispatch("workspace.hasWarmIndex", { workspaceId, path: pyFile })).warm).toBe(false);

		await service.dispatch("workspace.documentSymbols", { workspaceId, path: pyFile });

		expect((await service.dispatch("workspace.hasWarmIndex", { workspaceId, path: pyFile })).warm).toBe(true);
	}, 30_000);

	it("querying one language's warm index does not spawn or disturb the other's", async () => {
		const { root, tsFile, pyFile } = buildPolyglot();
		fixtureRoot = root;
		let tsSpawnCount = 0;
		let pySpawnCount = 0;
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => {
				if (descriptor.languageId === "typescript") tsSpawnCount++;
				if (descriptor.languageId === "python") pySpawnCount++;
				return new LspSymbolIndex(rootPath, descriptor, seedFile);
			},
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await service.dispatch("workspace.documentSymbols", { workspaceId, path: tsFile });
		expect(tsSpawnCount).toBe(1);
		expect(pySpawnCount).toBe(0);

		await service.dispatch("workspace.documentSymbols", { workspaceId, path: tsFile });
		expect(tsSpawnCount).toBe(1); // reused, not respawned

		await service.dispatch("workspace.documentSymbols", { workspaceId, path: pyFile });
		expect(pySpawnCount).toBe(1);
		expect(tsSpawnCount).toBe(1); // the Python query never touched the TypeScript index
	}, 30_000);

	it("populateSymbolGraph, given no path/seedFile, processes only the auto-detected primary language -- a known, honest scope, not silently mixing both", async () => {
		const { root } = buildPolyglot();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });

		// TypeScript is checked before Python in LANGUAGE_SERVER_DESCRIPTORS' declared order, and its
		// own bounded scan finds frontend/main.ts -- deterministic, exactly one language's files.
		expect(result.filesProcessed).toBe(1);
	}, 20_000);
});
