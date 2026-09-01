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
import type { DocumentSymbolEntry } from "../src/code-intelligence/document-symbol.ts";
import type { LanguageServerDescriptor } from "../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { type ClosableSymbolIndex, createLectorService, type LectorService, UnsupportedLanguage } from "../src/service.ts";
import { SqliteSymbolGraph } from "../src/symbol-graph/sqlite-symbol-graph.ts";
import type { WorkspaceLocation } from "../src/workspace/workspace-symbol.ts";
import { symbolSearchResult, TEST_SEMANTIC_PROVENANCE } from "./support/intelligence-provenance.ts";

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

function buildPolyglot(): { root: string; tsFile: string; pyFile: string; goFile: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-polyglot-"));

	const tsRoot = join(root, "frontend");
	mkdirSync(tsRoot);
	writeFileSync(join(tsRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	const tsFile = join(tsRoot, "main.ts");
	writeFileSync(
		tsFile,
		"export function tsLeaf(value: number): number { return value; }\nexport function tsOnly(a: number, b: number): number { return tsLeaf(a + b); }\n",
	);

	const pyRoot = join(root, "backend");
	mkdirSync(pyRoot);
	const pyFile = join(pyRoot, "main.py");
	writeFileSync(pyFile, "def python_leaf(value: int) -> int:\n    return value\n\ndef python_only(a: int, b: int) -> int:\n    return python_leaf(a + b)\n");

	const goRoot = join(root, "worker");
	mkdirSync(goRoot);
	writeFileSync(join(goRoot, "go.mod"), "module fixture/worker\n\ngo 1.22\n");
	const goFile = join(goRoot, "main.go");
	writeFileSync(goFile, "package worker\n\nfunc goLeaf(value int) int { return value }\n\nfunc goOnly(a int, b int) int { return goLeaf(a + b) }\n");

	return { root, tsFile, pyFile, goFile };
}

function buildPolyglotWithOrphanGoTest(): ReturnType<typeof buildPolyglot> & { orphanGoTest: string } {
	const fixture = buildPolyglot();
	const orphanGoTest = join(fixture.root, "e2e_concurrency_test.go");
	writeFileSync(orphanGoTest, "//go:build e2e\n\npackage fixture_test\n\nfunc TestConcurrency() {}\n");
	return { ...fixture, orphanGoTest };
}

function buildTypescriptRustScopes(): { root: string; tsRoot: string; rustRoot: string; tsFile: string; rustFile: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-polyglot-capacity-"));
	const tsRoot = join(root, "frontend");
	const rustRoot = join(root, "backend");
	mkdirSync(tsRoot);
	mkdirSync(join(rustRoot, "src"), { recursive: true });
	writeFileSync(join(tsRoot, "tsconfig.json"), "{}");
	const tsFile = join(tsRoot, "index.ts");
	writeFileSync(tsFile, "export function typescriptDomain() {}\n");
	writeFileSync(join(rustRoot, "Cargo.toml"), '[package]\nname = "capacity_fixture"\nversion = "0.1.0"\nedition = "2021"\n');
	const rustFile = join(rustRoot, "src", "lib.rs");
	writeFileSync(rustFile, "pub fn rust_domain() {}\n");
	return { root, tsRoot, rustRoot, tsFile, rustFile };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class ControlledSymbolIndex implements ClosableSymbolIndex {
	readonly provenance = TEST_SEMANTIC_PROVENANCE;

	constructor(
		private readonly documents: Promise<readonly DocumentSymbolEntry[]>,
		private readonly onDocumentSymbols: () => void,
		private readonly onClose: () => void,
	) {}

	findSymbols() {
		return Promise.resolve(symbolSearchResult());
	}

	goToDefinition(_location: WorkspaceLocation): Promise<readonly WorkspaceLocation[]> {
		return Promise.resolve([]);
	}

	documentSymbols(): Promise<readonly DocumentSymbolEntry[]> {
		this.onDocumentSymbols();
		return this.documents;
	}

	outgoingCalls(): Promise<[]> {
		return Promise.resolve([]);
	}

	close(): Promise<void> {
		this.onClose();
		return Promise.resolve();
	}
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
	it("TypeScript, Python, and Go files in the same workspace each resolve through their own language from path alone", async () => {
		const { root, tsFile, pyFile, goFile } = buildPolyglot();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const { symbols: tsSymbols } = await service.dispatch("workspace.documentSymbols", { workspaceId, path: tsFile });
		const { symbols: pySymbols } = await service.dispatch("workspace.documentSymbols", { workspaceId, path: pyFile });
		const { symbols: goSymbols } = await service.dispatch("workspace.documentSymbols", { workspaceId, path: goFile });

		expect(tsSymbols.map((s) => s.name)).toContain("tsOnly");
		expect(pySymbols.map((s) => s.name)).toContain("python_only");
		expect(goSymbols.map((s) => s.name)).toContain("goOnly");
		expect(tsSymbols.map((s) => s.name)).not.toContain("python_only");
		expect(pySymbols.map((s) => s.name)).not.toContain("goOnly");
		expect(goSymbols.map((s) => s.name)).not.toContain("tsOnly");
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

	it("workspace symbol search merges every detected language with per-backend provenance", async () => {
		const { root } = buildPolyglot();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.findSymbols", { workspaceId, query: "only" });

		expect(result.symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["tsOnly", "python_only", "goOnly"]));
		expect(result.provenance).toMatchObject({ languageId: "polyglot", backend: "polyglot-language-servers" });
		expect(result.sources?.map((source) => [source.provenance.languageId, source.status])).toEqual([
			["typescript", "ready"],
			["python", "ready"],
			["go", "ready"],
		]);
	}, 30_000);

	it("populateSymbolGraph processes every detected language instead of one arbitrary primary language", async () => {
		const { root } = buildPolyglot();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });
		const status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });

		expect(result.filesProcessed).toBe(3);
		expect(status.status).toBe("cached");
		if (status.status === "cached") {
			expect(status.generation.provenance).toMatchObject({ languageId: "polyglot", backend: "polyglot-language-servers" });
			expect(status.generation.sources?.map((source) => source.languageId)).toEqual(["typescript", "python", "go"]);
		}
	}, 30_000);

	it("persists a partial graph when one Go test file has no package metadata", async () => {
		const { root, orphanGoTest } = buildPolyglotWithOrphanGoTest();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });
		const status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });

		expect(result).toMatchObject({ completeness: "partial", filesAttempted: 4, filesProcessed: 4, filesFailed: 1 });
		expect(result.failures).toEqual([
			expect.objectContaining({
				path: orphanGoTest,
				operation: "outgoing-calls",
				provenance: expect.objectContaining({ languageId: "go", backend: "gopls" }),
			}),
		]);
		expect(result.failures[0]?.message).toContain("no package metadata for file");
		expect(status).toMatchObject({ status: "partial", generation: { result: { filesFailed: 1 } } });
	}, 30_000);

	it("keeps each language's call edges and source provenance after a graph reopen", async () => {
		const { root, tsFile, pyFile, goFile } = buildPolyglot();
		fixtureRoot = root;
		const graphPath = join(root, "polyglot-graph.db");
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolGraph: () => new SqliteSymbolGraph(graphPath),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });
		await service.close();
		service = undefined;

		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolGraph: () => new SqliteSymbolGraph(graphPath),
		});
		await service.dispatch("workspace.registerPath", { path: root });
		const tsReachable = await service.dispatch("workspace.reachableFrom", {
			workspaceId,
			path: tsFile,
			line: 2,
			character: 17,
			maxDepth: 1,
			kind: "calls",
		});
		const pythonReachable = await service.dispatch("workspace.reachableFrom", {
			workspaceId,
			path: pyFile,
			line: 4,
			character: 5,
			maxDepth: 1,
			kind: "calls",
		});
		const goReachable = await service.dispatch("workspace.reachableFrom", {
			workspaceId,
			path: goFile,
			line: 5,
			character: 6,
			maxDepth: 1,
			kind: "calls",
		});
		const status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });

		expect(tsReachable.symbols.map((symbol) => symbol.name)).toContain("tsLeaf");
		expect(pythonReachable.symbols.map((symbol) => symbol.name)).toContain("python_leaf");
		expect(goReachable.symbols.map((symbol) => symbol.name)).toContain("goLeaf");
		expect(status.status).toBe("cached");
		if (status.status === "cached") expect(status.generation.sources?.map((source) => source.languageId)).toEqual(["typescript", "python", "go"]);
	}, 30_000);

	it("keeps sibling foreground scopes responsive during polyglot population", async () => {
		const fixture = buildTypescriptRustScopes();
		fixtureRoot = fixture.root;
		const backgroundDocuments = deferred<readonly DocumentSymbolEntry[]>();
		const foregroundDocuments = deferred<readonly DocumentSymbolEntry[]>();
		const backgroundEntered = deferred<void>();
		const foregroundEntered = deferred<void>();
		let liveIndexes = 0;
		let maxLiveIndexes = 0;
		const createControlled = (documents: Promise<readonly DocumentSymbolEntry[]>, entered: () => void): ClosableSymbolIndex => {
			liveIndexes++;
			maxLiveIndexes = Math.max(maxLiveIndexes, liveIndexes);
			return new ControlledSymbolIndex(documents, entered, () => liveIndexes--);
		};

		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			maxActiveSymbolIndexes: 3,
			reservedForegroundSlots: 1,
			foregroundAdmissionQueueTimeoutMs: 2_000,
			maxQueuedForegroundAdmissions: 4,
			createSymbolIndex: (rootPath: string, _descriptor: LanguageServerDescriptor) => {
				if (rootPath === fixture.root) return createControlled(backgroundDocuments.promise, () => backgroundEntered.resolve());
				if (rootPath === fixture.tsRoot) return createControlled(foregroundDocuments.promise, () => foregroundEntered.resolve());
				return createControlled(Promise.resolve([]), () => {});
			},
		});
		const { workspaceId: rootWorkspace } = await service.dispatch("workspace.registerPath", { path: fixture.root });
		const { workspaceId: tsWorkspace } = await service.dispatch("workspace.registerPath", { path: fixture.tsRoot });
		const { workspaceId: rustWorkspace } = await service.dispatch("workspace.registerPath", { path: fixture.rustRoot });

		const background = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId: rootWorkspace, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		await backgroundEntered.promise;
		expect(service.symbolIndexPoolStatus()).toMatchObject({ active: 1, leased: 1 });

		const typescriptQuery = service.dispatch("workspace.documentSymbols", { workspaceId: tsWorkspace, path: fixture.tsFile });
		await foregroundEntered.promise;
		const rustQuery = service.dispatch("workspace.documentSymbols", { workspaceId: rustWorkspace, path: fixture.rustFile });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(service.symbolIndexPoolStatus()).toMatchObject({ active: 3, waitingForegroundAdmissions: 0 });

		foregroundDocuments.resolve([]);
		await Promise.all([typescriptQuery, rustQuery]);
		expect(maxLiveIndexes).toBe(3);
		expect(service.symbolIndexPoolStatus().active).toBeLessThanOrEqual(3);
		expect((await service.dispatch("job.status", { jobId: background.job.id })).job.status).toBe("running");
		backgroundDocuments.resolve([]);
	}, 10_000);
});
