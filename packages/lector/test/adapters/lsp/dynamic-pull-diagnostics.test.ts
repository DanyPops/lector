/**
 * Real end-to-end proof that LspSymbolIndex.diagnostics() consults dynamically-registered
 * capabilities, not just the static initialize response -- against a mock server that never
 * declares capabilities.diagnosticProvider at all, only registering pull-model diagnostic
 * support afterward via client/registerCapability (Roslyn/C#, Kotlin's own real pattern).
 * Before this fix, this server's diagnostics() call fell through to the push-wait branch and
 * timed out waiting for a publishDiagnostics notification this server never sends.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LspSymbolIndex } from "../../../src/adapters/lsp/lsp-symbol-index.ts";
import type { LanguageServerDescriptor } from "../../../src/domain/language-server-descriptor.ts";

const MOCK_SERVER_PATH = fileURLToPath(new URL("../../support/dynamic-pull-diagnostics-lsp-server.ts", import.meta.url));

const DYNAMIC_PULL_DIAGNOSTICS_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "mock",
	backendId: "dynamic-pull-diagnostics-mock",
	extensions: [".ts"],
	launch: { kind: "system-binary", command: "bun" },
	args: [MOCK_SERVER_PATH],
	rootMarkers: [],
	commonSeedCandidates: [],
	settleMs: 0,
};

let cwd: string | undefined;
let index: LspSymbolIndex | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (cwd) rmSync(cwd, { recursive: true, force: true });
	cwd = undefined;
});

/**
 * The registration is only ever sent once the server has actually been spawned and has received
 * "initialized" -- documentSymbols() (answered [] by this fixture's generic fallback) is used
 * purely to trigger that handshake, independent of the diagnostics-specific behavior under test.
 * Polls afterward rather than assuming the registration has already landed by the time the
 * handshake call itself resolves -- it is sent asynchronously, on the server's own schedule.
 */
async function warmUpAndWaitForDynamicDiagnosticRegistration(target: LspSymbolIndex, filePath: string, timeoutMs = 2000): Promise<void> {
	await target.documentSymbols(filePath);
	const started = Date.now();
	for (;;) {
		if (target.dynamicDiagnosticRegistrations.length > 0) return;
		if (Date.now() - started > timeoutMs) throw new Error("dynamic textDocument/diagnostic registration never arrived");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
}

describe("LspSymbolIndex against a server that registers pull-model diagnostics only dynamically", () => {
	it("never declares diagnosticProvider statically -- confirms this fixture actually exercises the dynamic-only path", async () => {
		cwd = mkdtempSync(join(tmpdir(), "lector-dynamic-pull-diagnostics-"));
		const filePath = join(cwd, "file.ts");
		writeFileSync(filePath, "const x = 1;\n");
		index = new LspSymbolIndex(cwd, DYNAMIC_PULL_DIAGNOSTICS_DESCRIPTOR);

		await index.diagnostics(filePath);

		expect(index.capabilities?.diagnosticProvider).toBeUndefined();
	});

	it("pulls real diagnostics via the dynamic registration once it lands, with the registered identifier echoed back", async () => {
		cwd = mkdtempSync(join(tmpdir(), "lector-dynamic-pull-diagnostics-"));
		const filePath = join(cwd, "file.ts");
		writeFileSync(filePath, "const x = 1;\n");
		index = new LspSymbolIndex(cwd, DYNAMIC_PULL_DIAGNOSTICS_DESCRIPTOR);

		await warmUpAndWaitForDynamicDiagnosticRegistration(index, filePath);
		expect(index.dynamicDiagnosticRegistrations).toEqual([{ identifier: "mock-dynamic" }]);

		const diagnostics = await index.diagnostics(filePath);
		expect(diagnostics.map((d) => d.message)).toEqual(["pulled via dynamic registration"]);
	});

	it("does not hang waiting for a push notification this server never sends", async () => {
		cwd = mkdtempSync(join(tmpdir(), "lector-dynamic-pull-diagnostics-"));
		const filePath = join(cwd, "file.ts");
		writeFileSync(filePath, "const x = 1;\n");
		index = new LspSymbolIndex(cwd, DYNAMIC_PULL_DIAGNOSTICS_DESCRIPTOR);
		await warmUpAndWaitForDynamicDiagnosticRegistration(index, filePath);

		const started = Date.now();
		await index.diagnostics(filePath);
		// The push-wait fallback this fixture would otherwise fall into blocks for 5000ms --
		// a real pull response arrives in single-digit milliseconds over a local pipe.
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
