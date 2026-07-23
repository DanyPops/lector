/**
 * createLectorFindSymbolsOperations wraps workspace.findSymbols with no
 * seedFile parameter anywhere in its own signature -- Lector's bounded
 * auto-discovery absorbs that tsserver detail entirely (lector commit
 * bf62f1d), so this operations layer, and the tool schema built on top of
 * it, never has to expose it.
 *
 * findSymbols' `directory` argument is an explicit per-call override of the
 * default -- a real, reported limitation this fixes: a fixed, session-cwd-
 * only default meant there was no way to get code intelligence for a
 * different project in the same session, even though read/write/edit could
 * already touch any repo.
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

	it(
		"searches an explicitly given directory instead of the default, in the same running Operations instance",
		async () => {
			const daemon = startIsolatedLectorDaemon();
			stopDaemon = daemon.stop;
			setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

			// The "session's own project" -- created once, exactly as index.ts's session_start
			// handler does, and never touched again below.
			projectDir = mkdtempSync(join(tmpdir(), "pi-lector-find-symbols-default-"));
			writeFileSync(join(projectDir, "index.ts"), "export function inDefaultProject() {}\n");

			// A completely different project the caller explicitly asks about instead.
			const otherProjectDir = mkdtempSync(join(tmpdir(), "pi-lector-find-symbols-other-"));
			writeFileSync(join(otherProjectDir, "index.ts"), "export function inOtherProject() {}\n");

			try {
				const ops = createLectorFindSymbolsOperations(projectDir);

				const defaultResults = await ops.findSymbols("inDefaultProject");
				expect(defaultResults.some((symbol) => symbol.name === "inDefaultProject")).toBe(true);

				const otherResults = await ops.findSymbols("inOtherProject", otherProjectDir);
				expect(otherResults.some((symbol) => symbol.name === "inOtherProject")).toBe(true);

				// The explicit-directory call must not have searched (or found anything in) the
				// default project, and vice versa -- these are two genuinely separate workspaces.
				expect(await ops.findSymbols("inOtherProject")).toEqual([]);
				expect(await ops.findSymbols("inDefaultProject", otherProjectDir)).toEqual([]);
			} finally {
				rmSync(otherProjectDir, { recursive: true, force: true });
			}
		},
		20_000,
	);
});
