import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { diagnostics } from "../../src/code-intelligence/diagnostics.ts";
import { documentSymbols } from "../../src/code-intelligence/document-symbols.ts";
import { findReferences } from "../../src/code-intelligence/find-references.ts";
import { goToDefinition } from "../../src/code-intelligence/go-to-definition.ts";
import { goToImplementation } from "../../src/code-intelligence/go-to-implementation.ts";
import { hoverAt } from "../../src/code-intelligence/hover-at.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { TreeSitterSymbolIndex } from "../../src/code-intelligence/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { TypeScriptCompilerSymbolIndex } from "../../src/code-intelligence/typescript-compiler-symbol-index.ts";
import { outgoingCalls } from "../../src/symbol-graph/outgoing-calls.ts";
import { findWorkspaceSymbols } from "../../src/workspace/find-workspace-symbols.ts";
import { findPositionOf } from "../support/find-position.ts";
import {
	materializeTypeScriptReferenceFixture,
	readTypeScriptReferenceManifest,
	type TypeScriptReferenceFixture,
} from "../support/typescript-reference-fixture.ts";

let fixture: TypeScriptReferenceFixture | undefined;
let lsp: LspSymbolIndex | undefined;

afterEach(async () => {
	await lsp?.close();
	lsp = undefined;
	fixture?.dispose();
	fixture = undefined;
});

describe("TypeScript/JavaScript reference fixture backend conformance", () => {
	it("keeps semantic LSP results and parser fallback results explicit on the same corpus", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const manifest = readTypeScriptReferenceManifest(fixture.root);
		lsp = new LspSymbolIndex(fixture.root, TYPESCRIPT_DESCRIPTOR, "packages/app/src/main.ts");
		const parser = new TreeSitterSymbolIndex(fixture.root);
		const compiler = new TypeScriptCompilerSymbolIndex(fixture.root);

		const [lspCheckout, compiledCheckout, parsedCheckout, parsedLegacy, parsedMalformed, parsedTsx, parsedJsx, parsedDeclaration, parsedOverload] =
			await Promise.all([
				findWorkspaceSymbols(lsp, "runCheckout"),
				compiler.findSymbols("runCheckout"),
				parser.findSymbols("runCheckout"),
				parser.findSymbols("LegacyGateway"),
				parser.findSymbols("unfinished"),
				parser.findSymbols("ReceiptView"),
				parser.findSymbols("LegacyWidget"),
				parser.findSymbols("ExternalReceipt"),
				parser.findSymbols("describeOrder"),
			]);

		expect(lspCheckout.symbols.some(({ name }) => name === "runCheckout")).toBe(true);
		expect(lspCheckout.provenance).toMatchObject({ fidelity: "semantic", backend: "typescript-language-server", authority: "language-server" });
		expect(compiledCheckout.symbols.some(({ name, kind }) => name === "runCheckout" && kind === "function")).toBe(true);
		expect(compiledCheckout.provenance).toMatchObject({ fidelity: "structural", authority: "compiler" });
		expect(parsedCheckout.symbols.some(({ name, kind }) => name === "runCheckout" && kind === "function")).toBe(true);
		expect(parsedCheckout.provenance).toMatchObject({ fidelity: "structural", authority: "parser" });
		expect(parsedLegacy.symbols.some(({ name, kind }) => name === "LegacyGateway" && kind === "class")).toBe(true);
		expect(parsedMalformed.symbols.some(({ name }) => name === "unfinished")).toBe(true);
		expect(parsedTsx.symbols.some(({ name }) => name === "ReceiptView")).toBe(true);
		expect(parsedJsx.symbols.some(({ name }) => name === "LegacyWidget")).toBe(true);
		expect(parsedDeclaration.symbols.some(({ name }) => name === "ExternalReceipt")).toBe(true);
		expect(parsedOverload.symbols.filter(({ name }) => name === "describeOrder")).toHaveLength(1);
		expect(manifest.expectedSymbols.some(({ name }) => name === "PaymentProcessor")).toBe(true);
	}, 30_000);

	it("refreshes an opened document with a monotonic full change after a filesystem mutation", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		lsp = new LspSymbolIndex(fixture.root, TYPESCRIPT_DESCRIPTOR, "packages/app/src/stripe.ts");
		const stripeFile = join(fixture.root, "packages/app/src/stripe.ts");

		expect((await documentSymbols(lsp, stripeFile)).some(({ name }) => name === "watcherVisibleSymbol")).toBe(false);
		appendFileSync(stripeFile, "\nexport function watcherVisibleSymbol(): boolean { return true; }\n");
		expect((await documentSymbols(lsp, stripeFile)).some(({ name }) => name === "watcherVisibleSymbol")).toBe(true);
	}, 30_000);

	it("exercises definitions, implementations, hover, calls, diagnostics, aliases, and project references through the live LSP", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		lsp = new LspSymbolIndex(fixture.root, TYPESCRIPT_DESCRIPTOR, "packages/app/src/main.ts");
		const contractsFile = join(fixture.root, "packages/contracts/src/payment.ts");
		const checkoutFile = join(fixture.root, "packages/app/src/checkout.ts");
		const diagnosticFile = join(fixture.root, "packages/app/src/type-error.ts");
		const stripeFile = join(fixture.root, "packages/app/src/stripe.ts");

		const processUsage = findPositionOf(checkoutFile, "processor.process(order)");
		const processDefinition = await goToDefinition(lsp, {
			path: checkoutFile,
			line: processUsage.line,
			character: processUsage.character + "processor.".length,
		});
		expect(processDefinition.some(({ path }) => path === contractsFile)).toBe(true);

		await documentSymbols(lsp, stripeFile);
		const factoryMethod = findPositionOf(stripeFile, "create(): PaymentProcessor");
		const implementations = await goToImplementation(lsp, {
			path: stripeFile,
			line: factoryMethod.line,
			character: factoryMethod.character + 1,
		});
		expect(implementations.map(({ path }) => path)).toContain(stripeFile);

		const checkoutDeclaration = findPositionOf(checkoutFile, "runCheckout(processor");
		const checkoutPosition = {
			path: checkoutFile,
			line: checkoutDeclaration.line,
			character: checkoutDeclaration.character + 1,
		};
		const hover = await hoverAt(lsp, checkoutPosition);
		expect(hover?.contents).toContain("runCheckout");
		const references = await findReferences(lsp, checkoutPosition, true);
		expect(references.filter(({ path }) => path === checkoutFile).length).toBeGreaterThan(1);

		const twiceDeclaration = findPositionOf(checkoutFile, "runCheckoutTwice(processor");
		const callees = await outgoingCalls(lsp, {
			path: checkoutFile,
			line: twiceDeclaration.line,
			character: twiceDeclaration.character + 1,
		});
		expect(callees.some(({ to }) => to.name === "runCheckout")).toBe(true);

		const reported = await diagnostics(lsp, diagnosticFile);
		expect(reported.some(({ severity, message }) => severity === "error" && message.includes("not assignable"))).toBe(true);

		const tsxSymbols = await documentSymbols(lsp, join(fixture.root, "packages/app/src/view.tsx"));
		const jsxSymbols = await documentSymbols(lsp, join(fixture.root, "packages/legacy/src/widget.jsx"));
		const esmSymbols = await documentSymbols(lsp, join(fixture.root, "packages/legacy/src/client.mjs"));
		const cjsSymbols = await documentSymbols(lsp, join(fixture.root, "packages/legacy/src/gateway.cjs"));
		const declarationSymbols = await documentSymbols(lsp, join(fixture.root, "packages/contracts/src/vendor.d.ts"));
		expect(tsxSymbols.some(({ name }) => name === "ReceiptView")).toBe(true);
		expect(jsxSymbols.some(({ name }) => name === "LegacyWidget")).toBe(true);
		expect(esmSymbols.some(({ name }) => name === "createLegacyClient")).toBe(true);
		expect(cjsSymbols.some(({ name }) => name === "LegacyGateway")).toBe(true);
		expect(declarationSymbols.some(({ name }) => name === "ExternalReceipt")).toBe(true);

		const unicodeFile = join(fixture.root, "packages/app/src/unicode.ts");
		const unicodeUsage = findPositionOf(unicodeFile, "describeCompass();");
		const unicodeDefinition = await goToDefinition(lsp, { path: unicodeFile, ...unicodeUsage });
		expect(unicodeDefinition.some(({ path }) => path === unicodeFile)).toBe(true);
	}, 30_000);
});
