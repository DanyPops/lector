import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { diagnostics } from "../../src/code-intelligence/diagnostics.ts";
import type { DocumentSymbolEntry } from "../../src/code-intelligence/document-symbol.ts";
import { documentSymbols } from "../../src/code-intelligence/document-symbols.ts";
import { findReferences } from "../../src/code-intelligence/find-references.ts";
import { goToDefinition } from "../../src/code-intelligence/go-to-definition.ts";
import { goToImplementation } from "../../src/code-intelligence/go-to-implementation.ts";
import { hoverAt } from "../../src/code-intelligence/hover-at.ts";
import { CPP_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { outgoingCalls } from "../../src/symbol-graph/outgoing-calls.ts";
import { findWorkspaceSymbols } from "../../src/workspace/find-workspace-symbols.ts";
import { type CppReferenceFixture, materializeCppReferenceFixture, readCppReferenceManifest } from "../support/cpp-reference-fixture.ts";
import { findPositionOf } from "../support/find-position.ts";

let fixture: CppReferenceFixture | undefined;
let lsp: LspSymbolIndex | undefined;

/** documentSymbols preserves LSP hierarchy (a namespace wraps its own members as children) rather
 * than flattening -- unlike the other reference fixtures' module-level functions, C++'s live
 * inside `namespace app { ... }`, so a name lookup must walk children too. */
function containsSymbolNamed(entries: readonly DocumentSymbolEntry[], name: string): boolean {
	return entries.some((entry) => entry.name === name || (entry.children ? containsSymbolNamed(entry.children, name) : false));
}

afterEach(async () => {
	await lsp?.close();
	lsp = undefined;
	fixture?.dispose();
	fixture = undefined;
});

describe("C/C++ reference fixture backend conformance", () => {
	it("finds real symbols across translation units, virtual implementations, templates, and macros", async () => {
		fixture = materializeCppReferenceFixture();
		const manifest = readCppReferenceManifest(fixture.root);
		lsp = new LspSymbolIndex(fixture.root, CPP_DESCRIPTOR, "src/checkout.cpp");

		const [checkoutSymbols, stripeSymbols, templateSymbols, macroSymbols] = await Promise.all([
			findWorkspaceSymbols(lsp, "RunCheckout"),
			findWorkspaceSymbols(lsp, "StripeProcessor"),
			findWorkspaceSymbols(lsp, "MaxValue"),
			findWorkspaceSymbols(lsp, "GreetFixture"),
		]);

		expect(checkoutSymbols.symbols.some(({ name }) => name === "RunCheckout")).toBe(true);
		expect(checkoutSymbols.provenance).toMatchObject({ fidelity: "semantic", backend: "clangd", authority: "language-server" });
		expect(stripeSymbols.symbols.some(({ name, kind }) => name === "StripeProcessor" && kind === "class")).toBe(true);
		expect(templateSymbols.symbols.some(({ name }) => name === "MaxValue")).toBe(true);
		expect(macroSymbols.symbols.some(({ name }) => name === "GreetFixture")).toBe(true);
		expect(manifest.expectedSymbols.some(({ name }) => name === "PaymentProcessor")).toBe(true);
	}, 60_000);

	it("refreshes an opened document with a monotonic full change after a filesystem mutation", async () => {
		fixture = materializeCppReferenceFixture();
		lsp = new LspSymbolIndex(fixture.root, CPP_DESCRIPTOR, "src/checkout.cpp");
		const stripeFile = join(fixture.root, "src/stripe.cpp");

		expect(containsSymbolNamed(await documentSymbols(lsp, stripeFile), "WatcherVisibleSymbol")).toBe(false);
		appendFileSync(stripeFile, "\nnamespace app {\nbool WatcherVisibleSymbol() { return true; }\n}  // namespace app\n");
		expect(containsSymbolNamed(await documentSymbols(lsp, stripeFile), "WatcherVisibleSymbol")).toBe(true);
	}, 60_000);

	it("exercises definitions, virtual implementations, hover, calls, and diagnostics through the live LSP", async () => {
		fixture = materializeCppReferenceFixture();
		lsp = new LspSymbolIndex(fixture.root, CPP_DESCRIPTOR, "src/checkout.cpp");
		const paymentFile = join(fixture.root, "include/contracts/payment.h");
		const checkoutFile = join(fixture.root, "src/checkout.cpp");
		const diagnosticFile = join(fixture.root, "src/type_error.cpp");
		const stripeFile = join(fixture.root, "src/stripe.cpp");
		const unicodeFile = join(fixture.root, "src/unicode.cpp");

		const processUsage = findPositionOf(checkoutFile, "processor.Process(normalized)");
		const processDefinition = await goToDefinition(lsp, {
			path: checkoutFile,
			line: processUsage.line,
			character: processUsage.character + "processor.".length,
		});
		expect(processDefinition.some(({ path }) => path === paymentFile)).toBe(true);

		await documentSymbols(lsp, stripeFile);
		const virtualDeclaration = findPositionOf(paymentFile, "virtual Receipt Process");
		const implementations = await goToImplementation(lsp, {
			path: paymentFile,
			line: virtualDeclaration.line,
			character: virtualDeclaration.character + "virtual Receipt ".length + 1,
		});
		expect(implementations.map(({ path }) => path)).toContain(stripeFile);

		const checkoutDeclaration = findPositionOf(checkoutFile, "Receipt RunCheckout(");
		const checkoutPosition = {
			path: checkoutFile,
			line: checkoutDeclaration.line,
			character: checkoutDeclaration.character + "Receipt ".length + 1,
		};
		const hover = await hoverAt(lsp, checkoutPosition);
		expect(hover?.contents).toContain("RunCheckout");
		const references = await findReferences(lsp, checkoutPosition, true);
		expect(references.filter(({ path }) => path === checkoutFile).length).toBeGreaterThan(1);

		const twiceDeclaration = findPositionOf(checkoutFile, "Receipt RunCheckoutTwice(");
		const callees = await outgoingCalls(lsp, {
			path: checkoutFile,
			line: twiceDeclaration.line,
			character: twiceDeclaration.character + "Receipt ".length + 1,
		});
		// Conditional, not required: clangd's own callHierarchy/outgoingCalls support is confirmed
		// version-dependent (18.1.3, the version CI's own apt-get install resolves, implements none of
		// it at all; 22.1.8 implements it fully) -- a clangd new enough to support it must report the
		// real callee correctly, a clangd that doesn't legitimately reports zero callees, matching the
		// same real, already-confirmed degrade-to-empty behavior asserted directly in
		// language-server-symbol-graph-conformance.test.ts.
		if (callees.length > 0) expect(callees.some(({ to }) => to.name === "RunCheckout")).toBe(true);

		const reported = await diagnostics(lsp, diagnosticFile);
		expect(reported.some(({ severity, message }) => severity === "error" && message.includes("incompatible type"))).toBe(true);

		const unicodeUsage = findPositionOf(unicodeFile, "return 指南针();");
		const unicodeDefinition = await goToDefinition(lsp, {
			path: unicodeFile,
			line: unicodeUsage.line,
			character: unicodeUsage.character + "return ".length,
		});
		expect(unicodeDefinition.some(({ path }) => path === unicodeFile)).toBe(true);
	}, 60_000);
});
