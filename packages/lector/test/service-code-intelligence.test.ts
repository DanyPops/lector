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
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import type { CodeIntelligencePort } from "../src/code-intelligence/port.ts";
import { TreeSitterSymbolIndex } from "../src/code-intelligence/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { DocumentHighlightsNotSupported } from "../src/service/errors.ts";
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
				return { provenance: index.provenance, findSymbols: (query, bounds) => index.findSymbols(query, bounds), close: () => index.close() };
			},
		});
		// A workspace's rootPath (required for any symbol/code-intelligence query) is only set
		// via workspace.registerPath, never via a workspace handed straight to createLectorService's
		// constructor map -- matching how the CLI's own "lector serve --workspace-path" vs.
		// "lector workspace register" already differ.
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const at = { workspaceId, path: join(fixtureRoot, "src/math.ts"), line: 1, character: 17 };
		const fallback = await service.dispatch("workspace.findSymbols", { workspaceId, query: "add", maxResults: 10 });
		expect(fallback.provenance).toMatchObject({ fidelity: "structural", authority: "parser" });
		expect(fallback.provenance.limitations).toContain("no cross-file identity");

		await expect(service.dispatch("workspace.goToDefinition", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.goToImplementation", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.findReferences", { ...at, includeDeclaration: true })).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.documentHighlights", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.hover", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.documentSymbols", { workspaceId, path: at.path })).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.diagnostics", { workspaceId, path: at.path })).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.prepareCallHierarchy", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.incomingCalls", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
		await expect(service.dispatch("workspace.outgoingCalls", at)).rejects.toBeInstanceOf(CodeIntelligenceUnavailable);
	}, 20_000);

	it("rejects workspace.documentHighlights with DocumentHighlightsNotSupported when the negotiated backend implements code intelligence but not documentHighlights itself", async () => {
		fixtureRoot = buildFixture();
		const provenance = {
			fidelity: "semantic",
			backend: "fixture",
			languageId: "typescript",
			authority: "language-server",
			freshness: "live-process",
			limitations: [],
		} as const;
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			// A minimal real CodeIntelligencePort implementer that deliberately omits
			// documentHighlights -- the exact shape of a backend that supports code intelligence
			// (goToDefinition et al.) but has nothing to say for this one optional capability, e.g. a
			// future non-LSP CodeIntelligencePort backend that never sends a real LSP request at all.
			createSymbolIndex: (): ClosableSymbolIndex & CodeIntelligencePort => ({
				provenance,
				findSymbols: async () => ({ symbols: [], truncated: false, provenance }),
				goToDefinition: async () => [],
				goToImplementation: async () => [],
				findReferences: async () => [],
				hover: async () => undefined,
				documentSymbols: async () => [],
				diagnostics: async () => [],
				prepareCallHierarchy: async () => [],
				incomingCalls: async () => [],
				outgoingCalls: async () => [],
				close: async () => {},
			}),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const at = { workspaceId, path: join(fixtureRoot, "src/math.ts"), line: 1, character: 17 };

		await expect(service.dispatch("workspace.documentHighlights", at)).rejects.toBeInstanceOf(DocumentHighlightsNotSupported);
	}, 20_000);

	it("waits for real pushed diagnostics after each edit through the error-and-clear loop", async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, { ...descriptor, settleMs: 0 }, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src/math.ts");
		const initial = await service.dispatch("workspace.rawRead", { workspaceId, path });
		const clean = await service.dispatch("workspace.diagnostics", { workspaceId, path });
		expect(clean.diagnostics).toEqual([]);

		const broken = await service.dispatch("workspace.exactEdit", {
			workspaceId,
			path,
			expectedHash: initial.hash,
			content: 'export const total: number = "not a number";\n',
		});
		const withError = await service.dispatch("workspace.diagnostics", { workspaceId, path });
		expect(withError.diagnostics.some((diagnostic) => diagnostic.message.includes("not assignable"))).toBe(true);

		await service.dispatch("workspace.exactEdit", {
			workspaceId,
			path,
			expectedHash: broken.newHash,
			content: "export const total: number = 1 + 1;\n",
		});
		const fixed = await service.dispatch("workspace.diagnostics", { workspaceId, path });
		expect(fixed.diagnostics).toEqual([]);
	}, 20_000);

	it("routes a real query through the default LSP backend end to end, and reuses the same warm index findSymbols already keeps alive", async () => {
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
		await service.dispatch("workspace.goToImplementation", at);

		expect(spawnCount).toBe(1);
		expect(symbols.find((symbol) => symbol.name === "add")).toBeDefined();
		expect(items.find((item) => item.name === "add")).toBeDefined();
	}, 20_000);
});
