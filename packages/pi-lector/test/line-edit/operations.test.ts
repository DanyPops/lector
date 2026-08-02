import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { createLectorLineEditOperations } from "../../extension/src/line-edit/operations.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

let projectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	projectDir = undefined;
});

describe("Lector-backed line-edit operations", () => {
	it("applies a real hash-guarded line edit via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-line-edit-fixture-"));
		const filePath = join(projectDir, "a.ts");
		writeFileSync(filePath, "line 1\nline 2\nline 3\n");

		const ops = createLectorLineEditOperations();
		const startHash = ops.lineHash("line 2");
		const result = await ops.lineEdit(filePath, [
			{ kind: "replace", startLine: 2, endLine: 2, expectedStartHash: startHash, expectedEndHash: startHash, lines: ["replaced"] },
		]);

		expect(result.path.endsWith("a.ts")).toBe(true);
		expect(readFileSync(filePath, "utf-8")).toBe("line 1\nreplaced\nline 3\n");
	}, 20_000);

	it("rejects a stale hash with a clear, actionable error, without writing anything", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-line-edit-fixture-"));
		const filePath = join(projectDir, "a.ts");
		writeFileSync(filePath, "line 1\nline 2\n");

		const ops = createLectorLineEditOperations();
		const wrongHash = ops.lineHash("not the real content");
		const attempt = ops.lineEdit(filePath, [
			{ kind: "replace", startLine: 2, endLine: 2, expectedStartHash: wrongHash, expectedEndHash: wrongHash, lines: ["x"] },
		]);

		await expect(attempt).rejects.toThrow(/hash-mismatch/);
		expect(readFileSync(filePath, "utf-8")).toBe("line 1\nline 2\n");
	}, 20_000);

	it("inserts a new line before an anchor via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-line-edit-fixture-"));
		const filePath = join(projectDir, "a.ts");
		writeFileSync(filePath, "line 1\nline 2\n");

		const ops = createLectorLineEditOperations();
		await ops.lineEdit(filePath, [{ kind: "insertBefore", atLine: 1, expectedHash: ops.lineHash("line 1"), lines: ["prefix"] }]);

		expect(readFileSync(filePath, "utf-8")).toBe("prefix\nline 1\nline 2\n");
	}, 20_000);
});
