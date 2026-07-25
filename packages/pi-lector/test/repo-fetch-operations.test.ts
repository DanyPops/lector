/**
 * repo_fetch against a real local git repository standing in for "the remote", injected via
 * the daemon's own createRepoFetcher override -- no live network in this test, same discipline
 * GitRepoFetcher's own adapter-level tests already use.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepoFetcher } from "@danypops/lector";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { createLectorRepoFetchOperations } from "../extension/src/repo-fetch-operations.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";
import { requireDefined } from "./support/require-defined.ts";

let sourceRepo: string | undefined;
let reposDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (sourceRepo) rmSync(sourceRepo, { recursive: true, force: true });
	if (reposDir) rmSync(reposDir, { recursive: true, force: true });
	sourceRepo = undefined;
	reposDir = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildSourceRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-repo-fetch-source-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "README.md"), "hello from the fixture repo\n");
	git(root, "add", "README.md");
	git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

describe("Lector-backed repo_fetch operations", () => {
	it("fetches a real repo via a running Lector daemon and returns a usable workspaceId", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "pi-lector-repo-fetch-cache-"));
		const daemon = startIsolatedLectorDaemon({
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const ops = createLectorRepoFetchOperations();
		const result = await ops.fetch("local-fixture", "acme", "widgets", null);

		expect(result.fromCache).toBe(false);
		expect(readFileSync(join(result.path, "README.md"), "utf8")).toBe("hello from the fixture repo\n");
		expect(typeof result.workspaceId).toBe("string");
	}, 20_000);

	it("a second fetch of the same reference is served from cache", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "pi-lector-repo-fetch-cache-"));
		const daemon = startIsolatedLectorDaemon({
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const ops = createLectorRepoFetchOperations();
		const first = await ops.fetch("local-fixture", "acme", "widgets", null);
		const second = await ops.fetch("local-fixture", "acme", "widgets", null);

		expect(second.fromCache).toBe(true);
		expect(second.workspaceId).toBe(first.workspaceId);
	}, 20_000);
});
