/**
 * Service-level concerns for the code-intelligence operations: workspace
 * resolution reuses the SAME warm index findSymbols already keeps alive
 * (no second subprocess spawned), and a non-LSP-backed index (e.g. a test
 * override using the tree-sitter backend) fails loudly via
 * CodeIntelligenceUnavailable rather than silently no-op-ing or crashing.
 * Full semantic correctness of each operation is already covered directly
 * against a live typescript-language-server in
 * test/adapters/lsp/lsp-symbol-index.test.ts; this file does not
 * repeat that.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/adapters/lsp/lsp-symbol-index.ts";
import { TreeSitterSymbolIndex } from "../src/adapters/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../src/domain/language-server-descriptor.ts";
import { type ClosableSymbolIndex, CodeIntelligenceUnavailable, createLectorService, type LectorService } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-code-intelligence-fixture-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "math.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	writeFileSync(
		join(root, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
	);
	return root;
}

describe("createLectorService's Tier A code-intelligence operations", () => {
	it("reject every operation with CodeIntelligenceUnavailable when the configured backend is tree-sitter-only", async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath): ClosableSymbolIndex => {
				const index = new TreeSitterSymbolIndex(rootPath);
				return { findSymbols: (query) => index.findSymbols(query), close: () => index.close() };
			},
		});
		// A workspace's rootPath (required for any symbol/code-intelligence query) is only set
		// via workspace.registerPath, never via a workspace handed straight to createLectorService's
		// constructor map -- matching how the CLI's own "lector serve --workspace-path" vs.
		// "lector workspace register" already differ.
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const at = { workspaceId, path: join(fixtureRoot, "src/math.ts"), line: 1, character: 17 };

		await expect(service.dispatch("workspace.goToDefinition", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.findReferences", { ...at, includeDeclaration: true })).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.hover", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.documentSymbols", { workspaceId, path: at.path })).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.diagnostics", { workspaceId, path: at.path })).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.prepareCallHierarchy", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.incomingCalls", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.outgoingCalls", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
	}, 20_000);

	it("routes a real query through the default LSP backend end to end, and reuses the same warm index findSymbols already keeps alive", async () => {
		fixtureRoot = buildFixture();
		let spawnCount = 0;
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, seedFile) => {
				spawnCount++;
				return new LspSymbolIndex(rootPath, TYPESCRIPT_DESCRIPTOR, seedFile);
			},
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		// findSymbols warms the index first...
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "add", seedFile: "src/math.ts" });
		// ...documentSymbols against the same workspace must reuse it, not spawn a second one.
		const { symbols } = await service.dispatch("workspace.documentSymbols", { workspaceId, path: join(fixtureRoot, "src/math.ts") });
		// ...and so must diagnostics and the call-hierarchy operations.
		await service.dispatch("workspace.diagnostics", { workspaceId, path: join(fixtureRoot, "src/math.ts") });
		const at = { workspaceId, path: join(fixtureRoot, "src/math.ts"), line: 1, character: 17 };
		const { items } = await service.dispatch("workspace.prepareCallHierarchy", at);
		await service.dispatch("workspace.incomingCalls", at);
		await service.dispatch("workspace.outgoingCalls", at);

		expect(spawnCount).toBe(1);
		expect(symbols.find((symbol) => symbol.name === "add")).toBeDefined();
		expect(items.find((item) => item.name === "add")).toBeDefined();
	}, 20_000);
});
