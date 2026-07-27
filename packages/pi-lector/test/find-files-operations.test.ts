import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorFindFilesOperations } from "../extension/src/find-files-operations.ts";
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

describe("Lector-backed find-files operations", () => {
	it("finds real files by glob pattern via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-find-files-fixture-"));
		mkdirSync(join(projectDir, "src"));
		writeFileSync(join(projectDir, "src", "index.ts"), "export const x = 1;\n");
		writeFileSync(join(projectDir, "README.md"), "# doc\n");

		const ops = createLectorFindFilesOperations();
		const result = await ops.findFiles(["*.ts"], projectDir, 100, 10_000);

		expect(result.paths).toEqual(["src/index.ts"]);
		expect(result.truncated).toBe(false);
	}, 20_000);

	it("signals truncation rather than silently returning a partial result", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-find-files-fixture-"));
		for (let n = 0; n < 5; n++) writeFileSync(join(projectDir, `f${n}.ts`), "export {};\n");

		const ops = createLectorFindFilesOperations();
		const result = await ops.findFiles(["*.ts"], projectDir, 2, 10_000);

		expect(result.truncated).toBe(true);
		expect(result.paths.length).toBe(2);
	}, 20_000);
});
