/**
 * repo_cache_list against a real local git repository standing in for "the remote", injected
 * via the daemon's own createRepoFetcher override -- no live network, same discipline
 * repo-fetch-operations.test.ts already uses.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepoFetcher } from "@danypops/lector";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { createRepoCacheListOperations } from "../extension/src/repo-cache-list-operations.ts";
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
	const root = mkdtempSync(join(tmpdir(), "pi-lector-repo-cache-list-source-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "README.md"), "hello\n");
	git(root, "add", "README.md");
	git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

describe("Lector-backed repo_cache_list operations", () => {
	it("returns an empty page before anything has been fetched, then lists a fetched repo via a running Lector daemon", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "pi-lector-repo-cache-list-cache-"));
		const daemon = await startIsolatedLectorDaemon({
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const listOps = createRepoCacheListOperations();
		const empty = await listOps.list({}, 10);
		expect(empty).toEqual({ entries: [], nextCursor: null });

		const fetchOps = createLectorRepoFetchOperations();
		const fetched = await fetchOps.fetch("local-fixture", "acme", "widgets", null);

		const page = await listOps.list({}, 10);
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]).toMatchObject({ host: "local-fixture", owner: "acme", repo: "widgets", registeredWorkspaceId: fetched.workspaceId });
	}, 20_000);

	it("filters by text across a running daemon's real cache", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "pi-lector-repo-cache-list-cache-"));
		const daemon = await startIsolatedLectorDaemon({
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const fetchOps = createLectorRepoFetchOperations();
		await fetchOps.fetch("local-fixture", "acme", "widgets", null);
		await fetchOps.fetch("local-fixture", "acme", "other-widgets", null);

		const listOps = createRepoCacheListOperations();
		const page = await listOps.list({ text: "other" }, 10);

		expect(page.entries.map((entry) => entry.repo)).toEqual(["other-widgets"]);
	}, 20_000);
});
