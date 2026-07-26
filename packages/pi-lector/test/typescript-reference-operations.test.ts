import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { findPositionOf } from "../../lector/test/support/find-position.ts";
import { materializeTypeScriptReferenceGitFixture, type TypeScriptReferenceFixture } from "../../lector/test/support/typescript-reference-fixture.ts";
import { createLectorCodeIntelligenceOperations } from "../extension/src/code-intelligence-operations.ts";
import { createLectorFindSymbolsOperations } from "../extension/src/find-symbols-operations.ts";
import { type FindSymbolsTheme, formatFindSymbolsResult } from "../extension/src/find-symbols-rendering.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

initTheme();

const plainTheme: FindSymbolsTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

let stopDaemon: (() => Promise<void>) | undefined;
let fixture: TypeScriptReferenceFixture | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	fixture?.dispose();
	fixture = undefined;
});

describe("TypeScript/JavaScript reference Pi operations", () => {
	it("preserves semantic provenance through operations and bounded rendering", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		fixture = materializeTypeScriptReferenceGitFixture();
		const findSymbols = createLectorFindSymbolsOperations();
		const intelligence = createLectorCodeIntelligenceOperations();

		const found = await findSymbols.findSymbols("runCheckout", fixture.root);
		expect(found.provenance).toMatchObject({ fidelity: "semantic", backend: "typescript-language-server" });
		expect(found.symbols.some(({ name }) => name === "runCheckout")).toBe(true);
		const rendered = formatFindSymbolsResult(found, "runCheckout", false, plainTheme);
		expect(rendered).toContain("semantic via typescript-language-server");
		expect(rendered.length).toBeLessThan(20_000);

		const checkoutPath = join(fixture.root, "packages/app/src/checkout.ts");
		const usage = findPositionOf(checkoutPath, "processor.process(order)");
		const definition = await intelligence.goToDefinition(checkoutPath, usage.line, usage.character + "processor.".length);
		expect(definition.provenance).toEqual(found.provenance);
		expect(definition.locations.some(({ path }) => path.endsWith("packages/contracts/src/purchase.ts"))).toBe(true);
	}, 30_000);
});
