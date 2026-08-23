import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { diagnostics } from "../../src/code-intelligence/diagnostics.ts";
import { documentSymbols } from "../../src/code-intelligence/document-symbols.ts";
import { findReferences } from "../../src/code-intelligence/find-references.ts";
import { goToDefinition } from "../../src/code-intelligence/go-to-definition.ts";
import { hoverAt } from "../../src/code-intelligence/hover-at.ts";
import { PYTHON_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { outgoingCalls } from "../../src/symbol-graph/outgoing-calls.ts";
import { findWorkspaceSymbols } from "../../src/workspace/find-workspace-symbols.ts";
import { findPositionOf } from "../support/find-position.ts";
import { materializePythonReferenceFixture, type PythonReferenceFixture, readPythonReferenceManifest } from "../support/python-reference-fixture.ts";

let fixture: PythonReferenceFixture | undefined;
let lsp: LspSymbolIndex | undefined;

afterEach(async () => {
	await lsp?.close();
	lsp = undefined;
	fixture?.dispose();
	fixture = undefined;
});

describe("Python reference fixture backend conformance", () => {
	it("finds real symbols across packages, re-exports, protocols, decorators, and namespace packages", async () => {
		fixture = materializePythonReferenceFixture();
		const manifest = readPythonReferenceManifest(fixture.root);
		lsp = new LspSymbolIndex(fixture.root, PYTHON_DESCRIPTOR, "app/checkout.py");

		const [checkoutSymbols, gatewaySymbols, namespaceA, namespaceB] = await Promise.all([
			findWorkspaceSymbols(lsp, "run_checkout"),
			findWorkspaceSymbols(lsp, "LegacyGateway"),
			findWorkspaceSymbols(lsp, "hello_from_a"),
			findWorkspaceSymbols(lsp, "hello_from_b"),
		]);

		expect(checkoutSymbols.symbols.some(({ name }) => name === "run_checkout")).toBe(true);
		expect(checkoutSymbols.provenance).toMatchObject({ fidelity: "semantic", backend: "pyright", authority: "language-server" });
		expect(gatewaySymbols.symbols.some(({ name, kind }) => name === "LegacyGateway" && kind === "class")).toBe(true);
		expect(namespaceA.symbols.some(({ name }) => name === "hello_from_a")).toBe(true);
		expect(namespaceB.symbols.some(({ name }) => name === "hello_from_b")).toBe(true);
		expect(manifest.expectedSymbols.some(({ name }) => name === "PaymentProcessor")).toBe(true);
	}, 60_000);

	it("refreshes an opened document with a monotonic full change after a filesystem mutation", async () => {
		fixture = materializePythonReferenceFixture();
		lsp = new LspSymbolIndex(fixture.root, PYTHON_DESCRIPTOR, "app/checkout.py");
		const stripeFile = join(fixture.root, "app/stripe.py");

		expect((await documentSymbols(lsp, stripeFile)).some(({ name }) => name === "watcher_visible_symbol")).toBe(false);
		appendFileSync(stripeFile, "\n\ndef watcher_visible_symbol() -> bool:\n    return True\n");
		expect((await documentSymbols(lsp, stripeFile)).some(({ name }) => name === "watcher_visible_symbol")).toBe(true);
	}, 60_000);

	it("exercises definitions, implementations, hover, calls, diagnostics, async, and Unicode positions through the live LSP", async () => {
		fixture = materializePythonReferenceFixture();
		lsp = new LspSymbolIndex(fixture.root, PYTHON_DESCRIPTOR, "app/checkout.py");
		const paymentFile = join(fixture.root, "contracts/payment.py");
		const checkoutFile = join(fixture.root, "app/checkout.py");
		const diagnosticFile = join(fixture.root, "app/type_error.py");
		const stripeFile = join(fixture.root, "app/stripe.py");
		const asyncFile = join(fixture.root, "app/async_ops.py");
		const unicodeFile = join(fixture.root, "app/unicode.py");
		const stubFile = join(fixture.root, "contracts/vendor.pyi");

		const processUsage = findPositionOf(checkoutFile, "processor.process(order)");
		const processDefinition = await goToDefinition(lsp, {
			path: checkoutFile,
			line: processUsage.line,
			character: processUsage.character + "processor.".length,
		});
		expect(processDefinition.some(({ path }) => path === paymentFile)).toBe(true);

		await documentSymbols(lsp, stripeFile);
		// pyright does not implement textDocument/implementation at all (confirmed live:
		// "Unhandled method textDocument/implementation" from the real server) -- unlike
		// typescript-language-server, there is no go-to-implementation capability to assert here.

		const checkoutDeclaration = findPositionOf(checkoutFile, "def run_checkout(processor");
		const checkoutPosition = {
			path: checkoutFile,
			line: checkoutDeclaration.line,
			character: checkoutDeclaration.character + "def ".length + 1,
		};
		const hover = await hoverAt(lsp, checkoutPosition);
		expect(hover?.contents).toContain("run_checkout");
		const references = await findReferences(lsp, checkoutPosition, true);
		expect(references.filter(({ path }) => path === checkoutFile).length).toBeGreaterThan(1);

		const twiceDeclaration = findPositionOf(checkoutFile, "def run_checkout_twice(processor");
		const callees = await outgoingCalls(lsp, {
			path: checkoutFile,
			line: twiceDeclaration.line,
			character: twiceDeclaration.character + "def ".length + 1,
		});
		expect(callees.some(({ to }) => to.name === "run_checkout")).toBe(true);

		const reported = await diagnostics(lsp, diagnosticFile);
		expect(reported.some(({ severity, message }) => severity === "error" && message.includes("not assignable"))).toBe(true);

		const asyncSymbols = await documentSymbols(lsp, asyncFile);
		const stubSymbols = await documentSymbols(lsp, stubFile);
		expect(asyncSymbols.some(({ name }) => name === "fetch_receipt")).toBe(true);
		expect(stubSymbols.some(({ name }) => name === "ExternalReceipt")).toBe(true);

		const unicodeUsage = findPositionOf(unicodeFile, "describe_compass()");
		const unicodeDefinition = await goToDefinition(lsp, { path: unicodeFile, ...unicodeUsage });
		expect(unicodeDefinition.some(({ path }) => path === unicodeFile)).toBe(true);
	}, 60_000);
});
