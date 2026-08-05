/**
 * Service-level wiring for responseFormat on workspace.findSymbols and
 * workspace.findReferences, against a real LSP-populated fixture. Includes
 * the token-count comparison the task itself requires as evidence the
 * parameter actually reduces payload size, not merely that it changes
 * shape. No tokenizer dependency exists in this codebase; ~4 chars/token is
 * the same rough estimate already used elsewhere for token budgeting, made
 * explicit here rather than silently assumed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { createLectorService, type LectorService } from "../src/service.ts";

const CHARS_PER_TOKEN_ESTIMATE = 4;

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-service-response-format-"));
	mkdirSync(join(root, "src"));
	writeFileSync(
		join(root, "src", "math.ts"),
		"export class MathUtils {\n\tadd(a: number, b: number): number {\n\t\treturn a + b;\n\t}\n\n\taddTwice(a: number, b: number): number {\n\t\treturn this.add(a, b) + this.add(a, b);\n\t}\n}\n",
	);
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	return root;
}

function estimatedTokens(value: unknown): number {
	return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN_ESTIMATE);
}

describe("responseFormat on workspace.findSymbols", () => {
	it('defaults to "detailed" when responseFormat is omitted, preserving current behavior', async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const result = await service.dispatch("workspace.findSymbols", { workspaceId, query: "add", seedFile: "src/math.ts" });
		const symbol = result.symbols.find((s) => s.name === "add");
		expect(symbol).toMatchObject({ name: "add", kind: "method" });
		expect(result.provenance).toHaveProperty("languageId");
	});

	it('"concise" strips real per-symbol provenance and narrows top-level provenance, while keeping name/kind/location intact', async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const result = await service.dispatch("workspace.findSymbols", { workspaceId, query: "add", seedFile: "src/math.ts", responseFormat: "concise" });
		const symbol = result.symbols.find((s) => s.name === "add");
		expect(symbol).not.toHaveProperty("containerName");
		expect(symbol).toMatchObject({ name: "add", kind: "method" });
		expect(result.provenance).not.toHaveProperty("languageId");
		expect(result.provenance).toHaveProperty("fidelity");
	});

	it('"concise" produces a real, measurably smaller payload than "detailed" for the identical query against the identical fixture', async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const detailed = await service.dispatch("workspace.findSymbols", { workspaceId, query: "add", seedFile: "src/math.ts", responseFormat: "detailed" });
		const concise = await service.dispatch("workspace.findSymbols", { workspaceId, query: "add", seedFile: "src/math.ts", responseFormat: "concise" });

		const detailedTokens = estimatedTokens(detailed);
		const conciseTokens = estimatedTokens(concise);
		expect(conciseTokens).toBeLessThan(detailedTokens);
		// Not just marginally smaller -- containerName + full provenance on every symbol is real weight.
		expect(conciseTokens).toBeLessThanOrEqual(detailedTokens * 0.85);
	});
});

describe("responseFormat on workspace.findReferences", () => {
	it('"concise" narrows provenance while leaving locations untouched, and is never larger than "detailed"', async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const mathFile = join(fixtureRoot, "src", "math.ts");
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "add", seedFile: "src/math.ts" });

		// "add" is declared on line 2 at the method name.
		const detailed = await service.dispatch("workspace.findReferences", { workspaceId, path: mathFile, line: 2, character: 2, includeDeclaration: true });
		const concise = await service.dispatch("workspace.findReferences", {
			workspaceId,
			path: mathFile,
			line: 2,
			character: 2,
			includeDeclaration: true,
			responseFormat: "concise",
		});

		expect(concise.locations).toEqual(detailed.locations);
		expect(concise.provenance).not.toHaveProperty("limitations");
		expect(estimatedTokens(concise)).toBeLessThanOrEqual(estimatedTokens(detailed));
	});
});
