/**
 * createLectorFindSymbolsOperations wraps workspace.findSymbols with no
 * seedFile parameter anywhere in its own signature -- Lector's bounded
 * auto-discovery absorbs that tsserver detail entirely (lector commit
 * bf62f1d), so this operations layer, and the tool schema built on top of
 * it, never has to expose it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorFindSymbolsOperations } from "../extension/src/find-symbols-operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

let projectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	projectDir = undefined;
});

describe("Lector-backed find-symbols operation", () => {
	it(
		"finds a real symbol via a running Lector daemon with no seedFile given anywhere",
		async () => {
			const daemon = startIsolatedLectorDaemon();
			stopDaemon = daemon.stop;
			setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

			projectDir = mkdtempSync(join(tmpdir(), "pi-lector-find-symbols-"));
			mkdirSync(join(projectDir, "src"));
			writeFileSync(join(projectDir, "src", "index.ts"), "export function greetLoudly(name: string): string {\n\treturn `HELLO ${name}`;\n}\n");

			const ops = createLectorFindSymbolsOperations(projectDir);
			const symbols = await ops.findSymbols("greetLoudly");

			const match = symbols.find((symbol) => symbol.name === "greetLoudly");
			expect(match).toBeDefined();
			expect(match?.kind).toBe("function");
		},
		20_000,
	);

	it(
		"returns an empty array for a query matching nothing, not an error",
		async () => {
			const daemon = startIsolatedLectorDaemon();
			stopDaemon = daemon.stop;
			setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

			projectDir = mkdtempSync(join(tmpdir(), "pi-lector-find-symbols-"));
			writeFileSync(join(projectDir, "index.ts"), "export const x = 1;\n");

			const ops = createLectorFindSymbolsOperations(projectDir);
			const symbols = await ops.findSymbols("ThisSymbolDefinitelyDoesNotExistAnywhere");

			expect(symbols).toEqual([]);
		},
		20_000,
	);
});
