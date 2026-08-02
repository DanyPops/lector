/**
 * The exact bug reported live: read/write/edit hard-locked to a single
 * session-wide workspace root, refusing to touch any absolute path outside
 * it. This test reproduces the real scenario -- one running session (one
 * set of Operations instances, created once, exactly as index.ts does at
 * session_start) that needs to read/edit files in two entirely unrelated
 * repositories -- and asserts both succeed, neither refused.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorEditOperations } from "../extension/src/edit/operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { createLectorReadOperations } from "../extension/src/read/operations.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

let repoA: string | undefined;
let repoB: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (repoA) rmSync(repoA, { recursive: true, force: true });
	if (repoB) rmSync(repoB, { recursive: true, force: true });
	repoA = undefined;
	repoB = undefined;
});

function fakeRepo(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(root, ".git"));
	return root;
}

describe("one session, two unrelated repositories", () => {
	it("reads a file from a completely different repository than wherever the session started, in the same tool instance", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		// repoA plays the role of "wherever the session's cwd happens to be" -- but nothing
		// about creating these Operations should depend on that at all anymore.
		repoA = fakeRepo("pi-lector-session-root-");
		repoB = fakeRepo("pi-lector-other-repo-");
		writeFileSync(join(repoB, "unrelated.txt"), "content that lives entirely outside the session's own repo");

		// Created exactly once, exactly as index.ts's session_start handler does -- no cwd
		// baked in anymore.
		const readOps = createLectorReadOperations();

		const content = await readOps.readFile(join(repoB, "unrelated.txt"));
		expect(content.toString("utf-8")).toBe("content that lives entirely outside the session's own repo");
	});

	it("edits files in two different repositories using the same long-lived Operations instance", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		repoA = fakeRepo("pi-lector-session-root-");
		repoB = fakeRepo("pi-lector-other-repo-");
		const pathA = join(repoA, "a.txt");
		const pathB = join(repoB, "b.txt");
		writeFileSync(pathA, "original A");
		writeFileSync(pathB, "original B");

		const editOps = createLectorEditOperations();

		await editOps.readFile(pathA);
		await editOps.writeFile(pathA, "edited A");
		await editOps.readFile(pathB);
		await editOps.writeFile(pathB, "edited B");

		expect(readFileSync(pathA, "utf-8")).toBe("edited A");
		expect(readFileSync(pathB, "utf-8")).toBe("edited B");
	});
});
