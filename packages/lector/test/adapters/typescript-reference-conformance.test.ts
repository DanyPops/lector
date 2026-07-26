import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { LspSymbolIndex } from "../../src/adapters/lsp/lsp-symbol-index.ts";
import { TreeSitterSymbolIndex } from "../../src/adapters/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { diagnostics } from "../../src/domain/diagnostics.ts";
import { documentSymbols } from "../../src/domain/document-symbols.ts";
import { findWorkspaceSymbols } from "../../src/domain/find-workspace-symbols.ts";
import { goToDefinition } from "../../src/domain/go-to-definition.ts";
import { goToImplementation } from "../../src/domain/go-to-implementation.ts";
import { hoverAt } from "../../src/domain/hover-at.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/domain/language-server-descriptor.ts";
import { outgoingCalls } from "../../src/domain/outgoing-calls.ts";
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

		const [lspCheckout, parsedCheckout, parsedLegacy, parsedMalformed, parsedTsx, parsedJsx, parsedDeclaration, parsedOverload] = await Promise.all([
			findWorkspaceSymbols(lsp, "runCheckout"),
			parser.findSymbols("runCheckout"),
			parser.findSymbols("LegacyGateway"),
			parser.findSymbols("unfinished"),
			parser.findSymbols("ReceiptView"),
			parser.findSymbols("LegacyWidget"),
			parser.findSymbols("ExternalReceipt"),
			parser.findSymbols("describeOrder"),
		]);

		expect(lspCheckout.some(({ name }) => name === "runCheckout")).toBe(true);
		expect(parsedCheckout.some(({ name, kind }) => name === "runCheckout" && kind === "function")).toBe(true);
		expect(parsedLegacy.some(({ name, kind }) => name === "LegacyGateway" && kind === "class")).toBe(true);
		expect(parsedMalformed.some(({ name }) => name === "unfinished")).toBe(true);
		expect(parsedTsx.some(({ name }) => name === "ReceiptView")).toBe(true);
		expect(parsedJsx.some(({ name }) => name === "LegacyWidget")).toBe(true);
		expect(parsedDeclaration.some(({ name }) => name === "ExternalReceipt")).toBe(true);
		expect(parsedOverload.filter(({ name }) => name === "describeOrder")).toHaveLength(1);
		expect(manifest.expectedSymbols.some(({ name }) => name === "PaymentProcessor")).toBe(true);
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

		const twiceDeclaration = findPositionOf(checkoutFile, "runCheckoutTwice(processor");
		const callees = await outgoingCalls(lsp, {
			path: checkoutFile,
			line: twiceDeclaration.line,
			character: twiceDeclaration.character + 1,
		});
		expect(callees.some(({ to }) => to.name === "runCheckout")).toBe(true);

		const reported = await diagnostics(lsp, diagnosticFile);
		expect(reported.some(({ severity, message }) => severity === "error" && message.includes("not assignable"))).toBe(true);

		const unicodeFile = join(fixture.root, "packages/app/src/unicode.ts");
		const unicodeUsage = findPositionOf(unicodeFile, "describeCompass();");
		const unicodeDefinition = await goToDefinition(lsp, { path: unicodeFile, ...unicodeUsage });
		expect(unicodeDefinition.some(({ path }) => path === unicodeFile)).toBe(true);
	}, 30_000);
});
