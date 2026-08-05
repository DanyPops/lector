import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { documentSymbols } from "../../src/code-intelligence/document-symbols.ts";
import { FallbackCodeIntelligenceIndex } from "../../src/code-intelligence/fallback-code-intelligence-index.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LanguageFileLimitExceeded, LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { TreeSitterSymbolIndex } from "../../src/code-intelligence/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { TypeScriptCompilerSymbolIndex } from "../../src/code-intelligence/typescript-compiler-symbol-index.ts";
import { deriveSourceManifest, SourceManifestLimitExceeded } from "../../src/workspace/source-manifest.ts";
import { findPositionOf } from "../support/find-position.ts";
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

	it("releaseFile frees an open-file slot instead of leaving the cap permanently exhausted " +
		"(regression: a bulk populateSymbolGraph crawl that never released a file left every " +
		"later query against ANY file, including brand-new ones, permanently failing)", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const seed = "packages/app/src/main.ts";
		const seedPath = join(fixture.root, seed);
		const checkoutPath = join(fixture.root, "packages/app/src/checkout.ts");
		lsp = new LspSymbolIndex(fixture.root, TYPESCRIPT_DESCRIPTOR, seed, { maxOpenFiles: 1 });

		await lsp.findSymbols("runCheckout"); // opens the seed file, filling the one-slot cap
		await expect(documentSymbols(lsp, checkoutPath)).rejects.toBeInstanceOf(LanguageFileLimitExceeded);

		await lsp.releaseFile(seedPath);
		const checkoutSymbols = await documentSymbols(lsp, checkoutPath);
		expect(checkoutSymbols.some((entry) => entry.name === "runCheckout")).toBe(true);

		// The released file still answers correctly afterward -- it reopens transparently, not
		// permanently broken by having once been closed.
		await lsp.releaseFile(checkoutPath);
		const seedSymbols = await documentSymbols(lsp, seedPath);
		expect(seedSymbols.length).toBeGreaterThan(0);
	}, 30_000);

	it("releaseFile is a harmless no-op for a file that was never opened, or before the process ever started", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const seed = "packages/app/src/main.ts";
		lsp = new LspSymbolIndex(fixture.root, TYPESCRIPT_DESCRIPTOR, seed, { maxOpenFiles: 1 });
		await expect(lsp.releaseFile(join(fixture.root, "packages/app/src/checkout.ts"))).resolves.toBeUndefined();
	});

	it("rejects unbounded settling configuration before spawning a server", () => {
		fixture = materializeTypeScriptReferenceFixture();

		expect(() => new LspSymbolIndex(fixture?.root ?? "", { ...TYPESCRIPT_DESCRIPTOR, settleMs: 30_001 })).toThrow(TypeError);
	});

	it("documentSymbols honors a per-call settleMs override, correctly, for a file the server has never opened", async () => {
		// This is the validated fast path populateSymbolGraph itself relies on
		// (POPULATION_SETTLE_MS): a real, never-before-opened file answers documentSymbols
		// correctly with zero settle wait, not just with the descriptor's normal default.
		fixture = materializeTypeScriptReferenceFixture();
		const seed = "packages/app/src/main.ts";
		lsp = new LspSymbolIndex(fixture.root, TYPESCRIPT_DESCRIPTOR, seed);

		const symbols = await lsp.documentSymbols(join(fixture.root, "packages/app/src/checkout.ts"), { settleMs: 0 });

		expect(symbols.some((entry) => entry.name === "runCheckout")).toBe(true);
	}, 20_000);

	it("rejects an out-of-range settleMs override the same way construction-time settleMs is rejected", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const seed = "packages/app/src/main.ts";
		lsp = new LspSymbolIndex(fixture.root, TYPESCRIPT_DESCRIPTOR, seed);

		await expect(lsp.documentSymbols(join(fixture.root, "packages/app/src/checkout.ts"), { settleMs: -1 })).rejects.toBeInstanceOf(TypeError);
		await expect(lsp.documentSymbols(join(fixture.root, "packages/app/src/checkout.ts"), { settleMs: 30_001 })).rejects.toBeInstanceOf(TypeError);
	}, 20_000);

	it("a settleMs override on documentSymbols never leaks into goToDefinition/hover's own default settle behavior", async () => {
		// The correctness boundary this whole optimization depends on: goToDefinition/hover
		// are NOT validated safe at reduced settle (a real, separately measured finding --
		// they can return a shallow "import statement" answer instead of the real cross-file
		// declaration). Calling documentSymbols with settleMs: 0 must never change what
		// goToDefinition does on the very same index instance afterward.
		fixture = materializeTypeScriptReferenceFixture();
		const seed = "packages/app/src/main.ts";
		lsp = new LspSymbolIndex(fixture.root, TYPESCRIPT_DESCRIPTOR, seed);
		const checkoutPath = join(fixture.root, "packages/app/src/checkout.ts");

		await lsp.documentSymbols(checkoutPath, { settleMs: 0 });
		const position = findPositionOf(checkoutPath, "runCheckout");
		const definitions = await lsp.goToDefinition({ path: checkoutPath, line: position.line, character: position.character });

		expect(definitions.length).toBeGreaterThan(0);
		expect(definitions[0]?.path).toBe(checkoutPath);
	}, 20_000);
});
