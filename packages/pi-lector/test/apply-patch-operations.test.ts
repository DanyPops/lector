import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorApplyPatchOperations } from "../extension/src/apply-patch-operations.ts";
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

describe("Lector-backed apply-patch operations", () => {
	it("applies a real unified diff via a running Lector daemon", async () => {
		const { contentHashOf } = await import("@danypops/lector");
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-apply-patch-fixture-"));
		const filePath = join(projectDir, "a.ts");
		const content = "line 1\nline 2\nline 3\n";
		writeFileSync(filePath, content);

		const ops = createLectorApplyPatchOperations();
		const result = await ops.applyPatch(filePath, contentHashOf(content), "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line 2 patched\n line 3\n");

		expect(result.path.endsWith("a.ts")).toBe(true);
		expect(readFileSync(filePath, "utf-8")).toBe("line 1\nline 2 patched\nline 3\n");
	}, 20_000);

	it("rejects a stale expected hash with a clear error, without writing anything", async () => {
		const { contentHashOf } = await import("@danypops/lector");
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-apply-patch-fixture-"));
		const filePath = join(projectDir, "a.ts");
		writeFileSync(filePath, "line 1\nline 2\n");

		const ops = createLectorApplyPatchOperations();
		const attempt = ops.applyPatch(filePath, contentHashOf("wrong content"), "@@ -1,2 +1,2 @@\n line 1\n-line 2\n+x\n");

		await expect(attempt).rejects.toThrow(/StaleExpectedHash/);
		expect(readFileSync(filePath, "utf-8")).toBe("line 1\nline 2\n");
	}, 20_000);
});
