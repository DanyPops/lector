/**
 * createLectorGitOperations wraps Lector's read-only git operations
 * (status/log/diff) over a running daemon. `directory` is required on
 * every call, same convention as find_symbols.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorGitOperations } from "../extension/src/git-operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

let repoRoot: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
	repoRoot = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-git-fixture-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "a.txt"), "hello\n");
	git(root, "add", "a.txt");
	git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

describe("Lector-backed git operations", () => {
	it("status reports a real modified file via a running Lector daemon", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		repoRoot = buildRepo();
		writeFileSync(join(repoRoot, "a.txt"), "changed\n");

		const ops = createLectorGitOperations();
		const summary = await ops.status(repoRoot);

		expect(summary.files).toContainEqual({ path: "a.txt", indexStatus: " ", workingDirStatus: "M" });
	}, 20_000);

	it("log returns a real commit via a running Lector daemon", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		repoRoot = buildRepo();

		const ops = createLectorGitOperations();
		const entries = await ops.log(repoRoot, 10);

		expect(entries.length).toBe(1);
		expect(entries[0]?.message).toBe("initial commit");
	}, 20_000);

	it("diff shows a real uncommitted change via a running Lector daemon", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		repoRoot = buildRepo();
		writeFileSync(join(repoRoot, "a.txt"), "changed content\n");

		const ops = createLectorGitOperations();
		const result = await ops.diff(repoRoot, undefined, 10_000);

		expect(result.diff).toContain("+changed content");
	}, 20_000);
});
