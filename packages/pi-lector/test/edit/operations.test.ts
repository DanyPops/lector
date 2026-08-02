/**
 * An edit whose file changed on disk between readFile and writeFile fails
 * with a clear error, and the file's on-disk content reflects the
 * interposing change, not a blind overwrite.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorEditOperations } from "../../extension/src/edit/operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
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

describe("Lector-backed edit tool", () => {
	it("commits normally when nothing changed the file between read and write", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-edit-"));
		const absolutePath = join(projectDir, "a.txt");
		writeFileSync(absolutePath, "original");

		const ops = createLectorEditOperations();
		await ops.readFile(absolutePath);
		await ops.writeFile(absolutePath, "edited");

		expect(readFileSync(absolutePath, "utf-8")).toBe("edited");
	});

	it("fails with a clear error, and leaves the interposing change on disk, when the file changed since it was read", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-edit-race-"));
		const absolutePath = join(projectDir, "a.txt");
		writeFileSync(absolutePath, "original");

		const { workspaceId } = await daemon.client.call("workspace.registerPath", { path: projectDir });
		const ops = createLectorEditOperations();

		// Simulates what the model's `read` tool call captured earlier in the conversation.
		await ops.readFile(absolutePath);

		// Someone -- another agent, an editor, a build step -- changes the file after that read.
		const observed = await daemon.client.call("workspace.rawRead", { workspaceId, path: "a.txt" });
		await daemon.client.call("workspace.exactEdit", {
			workspaceId,
			path: "a.txt",
			expectedHash: observed.hash,
			content: "changed underneath you",
		});

		await expect(ops.writeFile(absolutePath, "my intended edit")).rejects.toThrow(/changed on disk/);
		expect(readFileSync(absolutePath, "utf-8")).toBe("changed underneath you");
	});
});
