/**
 * createLectorFindSymbolsOperations wraps workspace.findSymbols with no
 * seedFile parameter anywhere in its own signature -- Lector's bounded
 * auto-discovery absorbs that tsserver detail entirely (lector commit
 * bf62f1d), so this operations layer, and the tool schema built on top of
 * it, never has to expose it.
 *
 * `directory` is required on every call, not an optional override with a
 * hidden cwd-based default -- exactly like read/write/edit require an
 * explicit path rather than defaulting to some magic file, a symbol query
 * requires an explicit project rather than silently defaulting to wherever
 * the session happens to be running.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorFindSymbolsOperations } from "../extension/src/find-symbols-operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

let projectDir: string | undefined;
let otherProjectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	if (otherProjectDir) rmSync(otherProjectDir, { recursive: true, force: true });
	projectDir = undefined;
	otherProjectDir = undefined;
});

describe("Lector-backed find-symbols operation", () => {
	it("finds a real symbol via a running Lector daemon with no seedFile given anywhere", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-find-symbols-"));
		mkdirSync(join(projectDir, "src"));
		// biome-ignore lint/suspicious/noTemplateCurlyInString: this is TypeScript source text written to a fixture file, not a template literal.
		writeFileSync(join(projectDir, "src", "index.ts"), "export function greetLoudly(name: string): string {\n\treturn `HELLO ${name}`;\n}\n");

		const ops = createLectorFindSymbolsOperations();
		const symbols = await ops.findSymbols("greetLoudly", projectDir);

		const match = symbols.symbols.find((symbol) => symbol.name === "greetLoudly");
		expect(match).toBeDefined();
		expect(match?.kind).toBe("function");
	}, 20_000);

	it("returns an empty array for a query matching nothing, not an error", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-find-symbols-"));
		writeFileSync(join(projectDir, "index.ts"), "export const x = 1;\n");

		const ops = createLectorFindSymbolsOperations();
		const symbols = await ops.findSymbols("ThisSymbolDefinitelyDoesNotExistAnywhere", projectDir);

		expect(symbols.symbols).toEqual([]);
	}, 20_000);

	it("searches whichever directory is given, and one Operations instance can search different directories across calls", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-find-symbols-default-"));
		writeFileSync(join(projectDir, "index.ts"), "export function inDefaultProject() {}\n");

		otherProjectDir = mkdtempSync(join(tmpdir(), "pi-lector-find-symbols-other-"));
		writeFileSync(join(otherProjectDir, "index.ts"), "export function inOtherProject() {}\n");

		const ops = createLectorFindSymbolsOperations();

		const firstResults = await ops.findSymbols("inDefaultProject", projectDir);
		expect(firstResults.symbols.some((symbol) => symbol.name === "inDefaultProject")).toBe(true);

		const secondResults = await ops.findSymbols("inOtherProject", otherProjectDir);
		expect(secondResults.symbols.some((symbol) => symbol.name === "inOtherProject")).toBe(true);

		// Neither search leaks into the other's project -- these are genuinely separate
		// workspaces, not a shared search scope with a remembered "current" directory.
		expect((await ops.findSymbols("inOtherProject", projectDir)).symbols).toEqual([]);
		expect((await ops.findSymbols("inDefaultProject", otherProjectDir)).symbols).toEqual([]);
	}, 20_000);
});
