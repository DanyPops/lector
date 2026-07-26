import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { FallbackCodeIntelligenceIndex } from "../../src/adapters/fallback-code-intelligence-index.ts";
import { LanguageFileLimitExceeded, LspSymbolIndex } from "../../src/adapters/lsp/lsp-symbol-index.ts";
import { deriveSourceManifest, SourceManifestLimitExceeded } from "../../src/adapters/source-manifest.ts";
import { TreeSitterSymbolIndex } from "../../src/adapters/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { TypeScriptCompilerSymbolIndex } from "../../src/adapters/typescript-compiler-symbol-index.ts";
import { documentSymbols } from "../../src/domain/document-symbols.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/domain/language-server-descriptor.ts";
import { materializeTypeScriptReferenceFixture, type TypeScriptReferenceFixture } from "../support/typescript-reference-fixture.ts";

let fixture: TypeScriptReferenceFixture | undefined;
let lsp: LspSymbolIndex | undefined;

afterEach(async () => {
	await lsp?.close();
	lsp = undefined;
	fixture?.dispose();
	fixture = undefined;
});

describe("TypeScript/JavaScript reference fixture boundaries", () => {
	it("labels compiler and parser recovery from malformed source as structural", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const compiler = new TypeScriptCompilerSymbolIndex(fixture.root);
		const parser = new TreeSitterSymbolIndex(fixture.root);

		const [compiled, parsed] = await Promise.all([compiler.findSymbols("unfinished"), parser.findSymbols("unfinished")]);

		expect(compiled.symbols.some(({ name }) => name === "unfinished")).toBe(true);
		expect(parsed.symbols.some(({ name }) => name === "unfinished")).toBe(true);
		expect(compiled.provenance).toMatchObject({ fidelity: "structural", authority: "compiler" });
		expect(parsed.provenance).toMatchObject({ fidelity: "structural", authority: "parser" });
	});

	it("falls back to explicitly structural discovery when the semantic server cannot start", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const semantic = new LspSymbolIndex(fixture.root, {
			...TYPESCRIPT_DESCRIPTOR,
			launch: { kind: "system-binary", command: "lector-language-server-does-not-exist" },
		});
		const compiler = new TypeScriptCompilerSymbolIndex(fixture.root);
		const resilient = new FallbackCodeIntelligenceIndex(semantic, [compiler]);

		const result = await resilient.findSymbols("runCheckout", { maxResults: 10 });

		expect(result.symbols.some(({ name }) => name === "runCheckout")).toBe(true);
		expect(result.provenance).toMatchObject({ fidelity: "structural", backend: "typescript-compiler", authority: "compiler" });
		await resilient.close();
	});

	it("reports structural result truncation at explicit file, byte, node, and output bounds", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const parser = new TreeSitterSymbolIndex(fixture.root, undefined, { maxFiles: 1, maxFileBytes: 64, maxTotalBytes: 64, maxResults: 1 });
		const compiler = new TypeScriptCompilerSymbolIndex(fixture.root, {
			maxFiles: 1,
			maxFileBytes: 64,
			maxTotalBytes: 64,
			maxResults: 1,
			maxNodesPerFile: 1,
		});

		const [parsed, compiled] = await Promise.all([parser.findSymbols("", { maxResults: 1 }), compiler.findSymbols("", { maxResults: 1 })]);

		expect(parsed.truncated).toBe(true);
		expect(compiled.truncated).toBe(true);
		expect(parsed.symbols.length).toBeLessThanOrEqual(1);
		expect(compiled.symbols.length).toBeLessThanOrEqual(1);
	});

	it("rejects a source generation that exceeds its cumulative content bound", async () => {
		fixture = materializeTypeScriptReferenceFixture();

		await expect(deriveSourceManifest(fixture.root, TYPESCRIPT_DESCRIPTOR.extensions, 200, 1)).rejects.toBeInstanceOf(SourceManifestLimitExceeded);
	});

	it("bounds opened files and source bytes before sending documents to the server", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const seed = "packages/app/src/main.ts";
		lsp = new LspSymbolIndex(fixture.root, TYPESCRIPT_DESCRIPTOR, seed, { maxOpenFiles: 1, maxFileBytes: 1 });
		await expect(lsp.findSymbols("runCheckout")).rejects.toBeInstanceOf(LanguageFileLimitExceeded);
		await lsp.close();

		lsp = new LspSymbolIndex(fixture.root, TYPESCRIPT_DESCRIPTOR, seed, { maxOpenFiles: 1 });
		await lsp.findSymbols("runCheckout");
		await expect(documentSymbols(lsp, join(fixture.root, "packages/app/src/checkout.ts"))).rejects.toBeInstanceOf(LanguageFileLimitExceeded);
	}, 30_000);

	it("rejects unbounded settling configuration before spawning a server", () => {
		fixture = materializeTypeScriptReferenceFixture();

		expect(() => new LspSymbolIndex(fixture?.root ?? "", { ...TYPESCRIPT_DESCRIPTOR, settleMs: 30_001 })).toThrow(TypeError);
	});
});
