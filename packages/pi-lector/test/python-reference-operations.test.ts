import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { findPositionOf } from "../../lector/test/support/find-position.ts";
import { materializePythonReferenceFixture, type PythonReferenceFixture } from "../../lector/test/support/python-reference-fixture.ts";
import { createLectorCodeIntelligenceOperations } from "../extension/src/code-intelligence/operations.ts";
import { createLectorFindSymbolsOperations } from "../extension/src/find-symbols/operations.ts";
import { type FindSymbolsTheme, formatFindSymbolsResult } from "../extension/src/find-symbols/rendering.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

initTheme();

const plainTheme: FindSymbolsTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

let stopDaemon: (() => Promise<void>) | undefined;
let fixture: PythonReferenceFixture | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	fixture?.dispose();
	fixture = undefined;
});

describe("Python reference Pi operations", () => {
	it("preserves semantic provenance through operations and bounded rendering", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		fixture = materializePythonReferenceFixture();
		const findSymbols = createLectorFindSymbolsOperations();
		const intelligence = createLectorCodeIntelligenceOperations();

		const found = await findSymbols.findSymbols("run_checkout", fixture.root);
		expect(found.provenance).toMatchObject({ fidelity: "semantic", backend: "pyright" });
		expect(found.symbols.some(({ name }) => name === "run_checkout")).toBe(true);
		const rendered = formatFindSymbolsResult(found, "run_checkout", false, plainTheme);
		expect(rendered).toContain("semantic via pyright");
		expect(rendered.length).toBeLessThan(20_000);

		const checkoutPath = join(fixture.root, "app/checkout.py");
		const usage = findPositionOf(checkoutPath, "processor.process(order)");
		const definition = await intelligence.goToDefinition(checkoutPath, usage.line, usage.character + "processor.".length);
		expect(definition.provenance).toEqual(found.provenance);
		expect(definition.locations.some(({ path }) => path.endsWith("contracts/payment.py"))).toBe(true);
	}, 30_000);
});
