import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { diagnostics } from "../../src/code-intelligence/diagnostics.ts";
import { documentSymbols } from "../../src/code-intelligence/document-symbols.ts";
import { findReferences } from "../../src/code-intelligence/find-references.ts";
import { goToDefinition } from "../../src/code-intelligence/go-to-definition.ts";
import { goToImplementation } from "../../src/code-intelligence/go-to-implementation.ts";
import { hoverAt } from "../../src/code-intelligence/hover-at.ts";
import { GO_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { subtypes, supertypes } from "../../src/code-intelligence/type-hierarchy.ts";
import { outgoingCalls } from "../../src/symbol-graph/outgoing-calls.ts";
import { findWorkspaceSymbols } from "../../src/workspace/find-workspace-symbols.ts";
import { findPositionOf } from "../support/find-position.ts";
import { type GoReferenceFixture, materializeGoReferenceFixture, readGoReferenceManifest } from "../support/go-reference-fixture.ts";

let fixture: GoReferenceFixture | undefined;
let lsp: LspSymbolIndex | undefined;

afterEach(async () => {
	await lsp?.close();
	lsp = undefined;
	fixture?.dispose();
	fixture = undefined;
});

describe("Go reference fixture backend conformance", () => {
	it("finds real symbols across packages, embedding, generics, aliases, and the go.work nested module", async () => {
		fixture = materializeGoReferenceFixture();
		const manifest = readGoReferenceManifest(fixture.root);
		lsp = new LspSymbolIndex(fixture.root, GO_DESCRIPTOR, "app/checkout.go");

		const [checkoutSymbols, stripeSymbols, embeddingSymbols, genericsSymbols, nestedSymbols] = await Promise.all([
			findWorkspaceSymbols(lsp, "RunCheckout"),
			findWorkspaceSymbols(lsp, "StripeProcessor"),
			findWorkspaceSymbols(lsp, "PremiumOrder"),
			findWorkspaceSymbols(lsp, "Max"),
			findWorkspaceSymbols(lsp, "NestedMarker"),
		]);

		expect(checkoutSymbols.symbols.some(({ name }) => name === "RunCheckout")).toBe(true);
		expect(checkoutSymbols.provenance).toMatchObject({ fidelity: "semantic", backend: "gopls", authority: "language-server" });
		expect(stripeSymbols.symbols.some(({ name, kind }) => name === "StripeProcessor" && kind === "struct")).toBe(true);
		expect(embeddingSymbols.symbols.some(({ name }) => name === "PremiumOrder")).toBe(true);
		expect(genericsSymbols.symbols.some(({ name }) => name === "Max")).toBe(true);
		expect(nestedSymbols.symbols.some(({ name }) => name === "NestedMarker")).toBe(true);
		expect(manifest.expectedSymbols.some(({ name }) => name === "PaymentProcessor")).toBe(true);
	}, 60_000);

	it("refreshes an opened document with a monotonic full change after a filesystem mutation", async () => {
		fixture = materializeGoReferenceFixture();
		lsp = new LspSymbolIndex(fixture.root, GO_DESCRIPTOR, "app/checkout.go");
		const stripeFile = join(fixture.root, "app/stripe.go");

		expect((await documentSymbols(lsp, stripeFile)).some(({ name }) => name === "WatcherVisibleSymbol")).toBe(false);
		appendFileSync(stripeFile, "\nfunc WatcherVisibleSymbol() bool {\n\treturn true\n}\n");
		expect((await documentSymbols(lsp, stripeFile)).some(({ name }) => name === "WatcherVisibleSymbol")).toBe(true);
	}, 60_000);

	it("exercises definitions, implementations, hover, calls, diagnostics, and Unicode positions through the live LSP", async () => {
		fixture = materializeGoReferenceFixture();
		lsp = new LspSymbolIndex(fixture.root, GO_DESCRIPTOR, "app/checkout.go");
		const paymentFile = join(fixture.root, "contracts/payment.go");
		const checkoutFile = join(fixture.root, "app/checkout.go");
		const diagnosticFile = join(fixture.root, "app/type_error.go");
		const stripeFile = join(fixture.root, "app/stripe.go");
		const unicodeFile = join(fixture.root, "app/unicode.go");

		const processUsage = findPositionOf(checkoutFile, "processor.Process(order)");
		const processDefinition = await goToDefinition(lsp, {
			path: checkoutFile,
			line: processUsage.line,
			character: processUsage.character + "processor.".length,
		});
		expect(processDefinition.some(({ path }) => path === paymentFile)).toBe(true);

		await documentSymbols(lsp, stripeFile);
		const interfaceDeclaration = findPositionOf(paymentFile, "type PaymentProcessor interface");
		const implementations = await goToImplementation(lsp, {
			path: paymentFile,
			line: interfaceDeclaration.line,
			character: interfaceDeclaration.character + "type ".length + 1,
		});
		expect(implementations.map(({ path }) => path)).toContain(stripeFile);
		const processorPosition = {
			path: paymentFile,
			line: interfaceDeclaration.line,
			character: interfaceDeclaration.character + "type ".length + 1,
		};
		expect((await subtypes(lsp, processorPosition)).map(({ name }) => name)).toContain("StripeProcessor");
		const stripeDeclaration = findPositionOf(stripeFile, "type StripeProcessor struct");
		expect(
			(await supertypes(lsp, { path: stripeFile, line: stripeDeclaration.line, character: stripeDeclaration.character + "type ".length + 1 })).map(
				({ name }) => name,
			),
		).toContain("PaymentProcessor");

		const checkoutDeclaration = findPositionOf(checkoutFile, "func RunCheckout(processor");
		const checkoutPosition = {
			path: checkoutFile,
			line: checkoutDeclaration.line,
			character: checkoutDeclaration.character + "func ".length + 1,
		};
		const hover = await hoverAt(lsp, checkoutPosition);
		expect(hover?.contents).toContain("RunCheckout");
		const references = await findReferences(lsp, checkoutPosition, true);
		expect(references.filter(({ path }) => path === checkoutFile).length).toBeGreaterThan(1);
		expect(await lsp.prepareRename(checkoutPosition)).not.toBeNull();
		const renameEdit = await lsp.rename(checkoutPosition, "RunCheckoutRenamed");
		expect(renameEdit.operations).toContainEqual(
			expect.objectContaining({
				kind: "text",
				path: checkoutFile,
				edits: expect.arrayContaining([expect.objectContaining({ newText: "RunCheckoutRenamed" })]),
			}),
		);

		const twiceDeclaration = findPositionOf(checkoutFile, "func RunCheckoutTwice(processor");
		const callees = await outgoingCalls(lsp, {
			path: checkoutFile,
			line: twiceDeclaration.line,
			character: twiceDeclaration.character + "func ".length + 1,
		});
		expect(callees.some(({ to }) => to.name === "RunCheckout")).toBe(true);

		const reported = await diagnostics(lsp, diagnosticFile);
		expect(reported.some(({ severity, message }) => severity === "error" && message.includes("cannot use"))).toBe(true);

		const unicodeUsage = findPositionOf(unicodeFile, "describeCompass()");
		const unicodeDefinition = await goToDefinition(lsp, { path: unicodeFile, ...unicodeUsage });
		expect(unicodeDefinition.some(({ path }) => path === unicodeFile)).toBe(true);
	}, 60_000);
});
