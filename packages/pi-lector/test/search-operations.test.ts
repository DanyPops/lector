import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { createLectorSearchOperations } from "../extension/src/search-operations.ts";
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

describe("Lector-backed search operations", () => {
	it("finds a real match via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-search-fixture-"));
		writeFileSync(join(projectDir, "a.txt"), "hello world\n");

		const ops = createLectorSearchOperations();
		const result = await ops.search("hello", projectDir, 100, 10_000);

		expect(result.matches).toContainEqual({ path: "a.txt", lineNumber: 1, line: "hello world\n", matchStart: 0, matchEnd: 5 });
		expect(result.truncated).toBe(false);
	}, 20_000);

	it("signals truncation rather than silently returning a partial result", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-search-fixture-"));
		writeFileSync(join(projectDir, "many.txt"), Array.from({ length: 20 }, () => "hello\n").join(""));

		const ops = createLectorSearchOperations();
		const result = await ops.search("hello", projectDir, 3, 10_000);

		expect(result.truncated).toBe(true);
		expect(result.matches.length).toBe(3);
	}, 20_000);
});
