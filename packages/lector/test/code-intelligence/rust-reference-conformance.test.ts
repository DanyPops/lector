import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { diagnostics } from "../../src/code-intelligence/diagnostics.ts";
import { documentSymbols } from "../../src/code-intelligence/document-symbols.ts";
import { findReferences } from "../../src/code-intelligence/find-references.ts";
import { goToDefinition } from "../../src/code-intelligence/go-to-definition.ts";
import { goToImplementation } from "../../src/code-intelligence/go-to-implementation.ts";
import { hoverAt } from "../../src/code-intelligence/hover-at.ts";
import { RUST_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { outgoingCalls } from "../../src/symbol-graph/outgoing-calls.ts";
import { findWorkspaceSymbols } from "../../src/workspace/find-workspace-symbols.ts";
import { findPositionOf } from "../support/find-position.ts";
import { materializeRustReferenceFixture, type RustReferenceFixture, readRustReferenceManifest } from "../support/rust-reference-fixture.ts";

let fixture: RustReferenceFixture | undefined;
let lsp: LspSymbolIndex | undefined;

afterEach(async () => {
	await lsp?.close();
	lsp = undefined;
	fixture?.dispose();
	fixture = undefined;
});

describe("Rust reference fixture backend conformance", () => {
	it("finds real symbols across crates, re-exports, generics, macros, and the workspace's nested crate", async () => {
		fixture = materializeRustReferenceFixture();
		const manifest = readRustReferenceManifest(fixture.root);
		lsp = new LspSymbolIndex(fixture.root, RUST_DESCRIPTOR, "app/src/lib.rs");

		const [checkoutSymbols, stripeSymbols, genericsSymbols, macroSymbols, nestedSymbols] = await Promise.all([
			findWorkspaceSymbols(lsp, "run_checkout"),
			findWorkspaceSymbols(lsp, "StripeProcessor"),
			findWorkspaceSymbols(lsp, "max_value"),
			findWorkspaceSymbols(lsp, "greet_fixture"),
			findWorkspaceSymbols(lsp, "nested_marker"),
		]);

		expect(checkoutSymbols.symbols.some(({ name }) => name === "run_checkout")).toBe(true);
		expect(checkoutSymbols.provenance).toMatchObject({ fidelity: "semantic", backend: "rust-analyzer", authority: "language-server" });
		expect(stripeSymbols.symbols.some(({ name, kind }) => name === "StripeProcessor" && kind === "struct")).toBe(true);
		expect(genericsSymbols.symbols.some(({ name }) => name === "max_value")).toBe(true);
		expect(macroSymbols.symbols.some(({ name }) => name === "greet_fixture")).toBe(true);
		expect(nestedSymbols.symbols.some(({ name }) => name === "nested_marker")).toBe(true);
		expect(manifest.expectedSymbols.some(({ name }) => name === "PaymentProcessor")).toBe(true);
	}, 60_000);

	it("refreshes an opened document with a monotonic full change after a filesystem mutation", async () => {
		fixture = materializeRustReferenceFixture();
		lsp = new LspSymbolIndex(fixture.root, RUST_DESCRIPTOR, "app/src/lib.rs");
		const stripeFile = join(fixture.root, "app/src/stripe.rs");

		expect((await documentSymbols(lsp, stripeFile)).some(({ name }) => name === "watcher_visible_symbol")).toBe(false);
		appendFileSync(stripeFile, "\npub fn watcher_visible_symbol() -> bool {\n    true\n}\n");
		expect((await documentSymbols(lsp, stripeFile)).some(({ name }) => name === "watcher_visible_symbol")).toBe(true);
	}, 60_000);

	it("exercises definitions, implementations, hover, calls, diagnostics, and Unicode positions through the live LSP", async () => {
		fixture = materializeRustReferenceFixture();
		lsp = new LspSymbolIndex(fixture.root, RUST_DESCRIPTOR, "app/src/lib.rs");
		const paymentFile = join(fixture.root, "contracts/src/payment.rs");
		const checkoutFile = join(fixture.root, "app/src/checkout.rs");
		const diagnosticFile = join(fixture.root, "app/src/type_error.rs");
		const stripeFile = join(fixture.root, "app/src/stripe.rs");
		const unicodeFile = join(fixture.root, "app/src/unicode.rs");

		const processUsage = findPositionOf(checkoutFile, "processor.process(order)");
		const processDefinition = await goToDefinition(lsp, {
			path: checkoutFile,
			line: processUsage.line,
			character: processUsage.character + "processor.".length,
		});
		expect(processDefinition.some(({ path }) => path === paymentFile)).toBe(true);

		await documentSymbols(lsp, stripeFile);
		const traitDeclaration = findPositionOf(paymentFile, "pub trait PaymentProcessor");
		const implementations = await goToImplementation(lsp, {
			path: paymentFile,
			line: traitDeclaration.line,
			character: traitDeclaration.character + "pub trait ".length + 1,
		});
		expect(implementations.map(({ path }) => path)).toContain(stripeFile);

		const checkoutDeclaration = findPositionOf(checkoutFile, "pub fn run_checkout(processor");
		const checkoutPosition = {
			path: checkoutFile,
			line: checkoutDeclaration.line,
			character: checkoutDeclaration.character + "pub fn ".length + 1,
		};
		const hover = await hoverAt(lsp, checkoutPosition);
		expect(hover?.contents).toContain("run_checkout");
		const references = await findReferences(lsp, checkoutPosition, true);
		expect(references.filter(({ path }) => path === checkoutFile).length).toBeGreaterThan(1);

		const twiceDeclaration = findPositionOf(checkoutFile, "pub fn run_checkout_twice(processor");
		const callees = await outgoingCalls(lsp, {
			path: checkoutFile,
			line: twiceDeclaration.line,
			character: twiceDeclaration.character + "pub fn ".length + 1,
		});
		expect(callees.some(({ to }) => to.name === "run_checkout")).toBe(true);

		const reported = await diagnostics(lsp, diagnosticFile);
		expect(reported.some(({ severity, message }) => severity === "error" && message.includes("mismatched types"))).toBe(true);

		const unicodeUsage = findPositionOf(unicodeFile, "describe_compass()");
		const unicodeDefinition = await goToDefinition(lsp, { path: unicodeFile, ...unicodeUsage });
		expect(unicodeDefinition.some(({ path }) => path === unicodeFile)).toBe(true);
	}, 60_000);
});
