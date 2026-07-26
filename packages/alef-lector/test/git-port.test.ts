import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../src/client.js";
import { LectorGitPort } from "../src/git-port.js";
import { resetWorkspaceRegistrationForTests } from "../src/workspace-registration.js";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.js";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("LectorGitPort", () => {
	let stop: (() => Promise<void>) | undefined;
	let repoPath: string;

	beforeEach(() => {
		const daemon = startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		stop = daemon.stop;
		repoPath = mkdtempSync(join(tmpdir(), "alef-lector-git-test-"));
	});

	afterEach(async () => {
		resetLectorClientForTests();
		resetWorkspaceRegistrationForTests();
		await stop?.();
		rmSync(repoPath, { recursive: true, force: true });
	});

	it("reports false for a workspace with no .git directory", async () => {
		const port = new LectorGitPort(repoPath);
		expect(await port.isGitRepository()).toBe(false);
	});

	it("reports status/log/diff against a real repository", async () => {
		git(repoPath, "init", "--initial-branch=main", "-q");
		git(repoPath, "config", "user.email", "test@example.com");
		git(repoPath, "config", "user.name", "Test");
		writeFileSync(join(repoPath, "committed.txt"), "hello\n");
		git(repoPath, "add", "committed.txt");
		git(repoPath, "commit", "-q", "-m", "initial commit");
		writeFileSync(join(repoPath, "untracked.txt"), "new\n");

		const port = new LectorGitPort(repoPath);
		expect(await port.isGitRepository()).toBe(true);

		const status = await port.status();
		expect(status.current).toBe("main");
		expect(status.files.some((f) => f.path === "untracked.txt")).toBe(true);

		const entries = await port.log(10);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.message).toBe("initial commit");

		const diff = await port.diff(undefined, 10_000);
		expect(diff.diff).toBe("");
		expect(diff.truncated).toBe(false);
	});
});
