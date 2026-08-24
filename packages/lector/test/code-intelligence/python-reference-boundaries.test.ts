import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { documentSymbols } from "../../src/code-intelligence/document-symbols.ts";
import { FallbackCodeIntelligenceIndex } from "../../src/code-intelligence/fallback-code-intelligence-index.ts";
import { PYTHON_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LanguageFileLimitExceeded, LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { TreeSitterSymbolIndex } from "../../src/code-intelligence/tree-sitter/tree-sitter-symbol-index.ts";
import { deriveSourceManifest, SourceManifestLimitExceeded } from "../../src/workspace/source-manifest.ts";
import { findPositionOf } from "../support/find-position.ts";
import { materializePythonReferenceFixture, type PythonReferenceFixture } from "../support/python-reference-fixture.ts";

const PYTHON_TREE_SITTER_LANGUAGE = { languageId: "python", backend: "tree-sitter-python", extensions: [".py", ".pyi"] } as const;

let fixture: PythonReferenceFixture | undefined;
let lsp: LspSymbolIndex | undefined;

afterEach(async () => {
	await lsp?.close();
	lsp = undefined;
	fixture?.dispose();
	fixture = undefined;
});

describe("Python reference fixture boundaries", () => {
	it("labels tree-sitter recovery from malformed source as structural", async () => {
		fixture = materializePythonReferenceFixture();
		const parser = new TreeSitterSymbolIndex(fixture.root, undefined, { language: PYTHON_TREE_SITTER_LANGUAGE });

		const parsed = await parser.findSymbols("unfinished");

		expect(parsed.symbols.some(({ name }) => name === "unfinished")).toBe(true);
		expect(parsed.provenance).toMatchObject({ fidelity: "structural", authority: "parser", backend: "tree-sitter-python" });
	});

	it("falls back to explicitly structural discovery when the semantic server cannot start", async () => {
		fixture = materializePythonReferenceFixture();
		const semantic = new LspSymbolIndex(fixture.root, {
			...PYTHON_DESCRIPTOR,
			launch: { kind: "system-binary", command: "lector-language-server-does-not-exist" },
		});
		const parser = new TreeSitterSymbolIndex(fixture.root, undefined, { language: PYTHON_TREE_SITTER_LANGUAGE });
		const resilient = new FallbackCodeIntelligenceIndex(semantic, [parser]);

		const result = await resilient.findSymbols("run_checkout", { maxResults: 10 });

		expect(result.symbols.some(({ name }) => name === "run_checkout")).toBe(true);
		expect(result.provenance).toMatchObject({ fidelity: "structural", backend: "tree-sitter-python", authority: "parser" });
		await resilient.close();
	});

	it("reports structural result truncation at explicit file, byte, and output bounds", async () => {
		fixture = materializePythonReferenceFixture();
		const parser = new TreeSitterSymbolIndex(fixture.root, undefined, {
			maxFiles: 1,
			maxFileBytes: 64,
			maxTotalBytes: 64,
			maxResults: 1,
			language: PYTHON_TREE_SITTER_LANGUAGE,
		});

		const parsed = await parser.findSymbols("", { maxResults: 1 });

		expect(parsed.truncated).toBe(true);
		expect(parsed.symbols.length).toBeLessThanOrEqual(1);
	});

	it("rejects a source generation that exceeds its cumulative content bound", async () => {
		fixture = materializePythonReferenceFixture();

		await expect(deriveSourceManifest(fixture.root, PYTHON_DESCRIPTOR.extensions, 200, 1)).rejects.toBeInstanceOf(SourceManifestLimitExceeded);
	});

	it("bounds opened files and source bytes before sending documents to the server", async () => {
		fixture = materializePythonReferenceFixture();
		const seed = "app/checkout.py";
		lsp = new LspSymbolIndex(fixture.root, PYTHON_DESCRIPTOR, seed, { maxOpenFiles: 1, maxFileBytes: 1 });
		await expect(lsp.findSymbols("run_checkout")).rejects.toBeInstanceOf(LanguageFileLimitExceeded);
		await lsp.close();

		lsp = new LspSymbolIndex(fixture.root, PYTHON_DESCRIPTOR, seed, { maxOpenFiles: 1 });
		await lsp.findSymbols("run_checkout");
		await expect(documentSymbols(lsp, join(fixture.root, "contracts/payment.py"))).rejects.toBeInstanceOf(LanguageFileLimitExceeded);
	}, 30_000);

	it("releaseFile frees an open-file slot instead of leaving the cap permanently exhausted", async () => {
		fixture = materializePythonReferenceFixture();
		const seed = "app/checkout.py";
		const seedPath = join(fixture.root, seed);
		const paymentPath = join(fixture.root, "contracts/payment.py");
		lsp = new LspSymbolIndex(fixture.root, PYTHON_DESCRIPTOR, seed, { maxOpenFiles: 1 });

		await lsp.findSymbols("run_checkout"); // opens the seed file, filling the one-slot cap
		await expect(documentSymbols(lsp, paymentPath)).rejects.toBeInstanceOf(LanguageFileLimitExceeded);

		await lsp.releaseFile(seedPath);
		const paymentSymbols = await documentSymbols(lsp, paymentPath);
		expect(paymentSymbols.some((entry) => entry.name === "PaymentProcessor")).toBe(true);

		await lsp.releaseFile(paymentPath);
		const seedSymbols = await documentSymbols(lsp, seedPath);
		expect(seedSymbols.length).toBeGreaterThan(0);
	}, 30_000);

	it("releaseFile is a harmless no-op for a file that was never opened, or before the process ever started", async () => {
		fixture = materializePythonReferenceFixture();
		const seed = "app/checkout.py";
		lsp = new LspSymbolIndex(fixture.root, PYTHON_DESCRIPTOR, seed, { maxOpenFiles: 1 });
		await expect(lsp.releaseFile(join(fixture.root, "contracts/payment.py"))).resolves.toBeUndefined();
	});

	it("rejects unbounded settling configuration before spawning a server", () => {
		fixture = materializePythonReferenceFixture();

		expect(() => new LspSymbolIndex(fixture?.root ?? "", { ...PYTHON_DESCRIPTOR, settleMs: 30_001 })).toThrow(TypeError);
	});

	it("documentSymbols honors a per-call settleMs override, correctly, for a file the server has never opened", async () => {
		fixture = materializePythonReferenceFixture();
		const seed = "app/checkout.py";
		lsp = new LspSymbolIndex(fixture.root, PYTHON_DESCRIPTOR, seed);

		const symbols = await lsp.documentSymbols(join(fixture.root, "contracts/payment.py"), { settleMs: 0 });

		expect(symbols.some((entry) => entry.name === "PaymentProcessor")).toBe(true);
	}, 20_000);

	it("rejects an out-of-range settleMs override the same way construction-time settleMs is rejected", async () => {
		fixture = materializePythonReferenceFixture();
		const seed = "app/checkout.py";
		lsp = new LspSymbolIndex(fixture.root, PYTHON_DESCRIPTOR, seed);

		await expect(lsp.documentSymbols(join(fixture.root, "contracts/payment.py"), { settleMs: -1 })).rejects.toBeInstanceOf(TypeError);
		await expect(lsp.documentSymbols(join(fixture.root, "contracts/payment.py"), { settleMs: 30_001 })).rejects.toBeInstanceOf(TypeError);
	}, 20_000);

	it("a settleMs override on documentSymbols never leaks into goToDefinition's own default settle behavior", async () => {
		fixture = materializePythonReferenceFixture();
		const seed = "app/checkout.py";
		lsp = new LspSymbolIndex(fixture.root, PYTHON_DESCRIPTOR, seed);
		const checkoutPath = join(fixture.root, "app/checkout.py");

		await lsp.documentSymbols(checkoutPath, { settleMs: 0 });
		const position = findPositionOf(checkoutPath, "run_checkout");
		const definitions = await lsp.goToDefinition({ path: checkoutPath, line: position.line, character: position.character });

		expect(definitions.length).toBeGreaterThan(0);
		expect(definitions[0]?.path).toBe(checkoutPath);
	}, 20_000);
});
