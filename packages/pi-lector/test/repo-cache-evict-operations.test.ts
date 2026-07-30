/**
 * repo_cache_evict against a real local git repository standing in for "the remote", injected
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
import { createRepoCacheEvictOperations } from "../extension/src/repo-cache-evict-operations.ts";
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
	const root = mkdtempSync(join(tmpdir(), "pi-lector-repo-cache-evict-source-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "README.md"), "hello\n");
	git(root, "add", "README.md");
	git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

describe("Lector-backed repo_cache_evict operations", () => {
	it("returns evicted: false for a reference that was never fetched", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "pi-lector-repo-cache-evict-cache-"));
		const daemon = await startIsolatedLectorDaemon({
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const evictOps = createRepoCacheEvictOperations();
		await expect(evictOps.evict("local-fixture", "acme", "widgets", null)).resolves.toEqual({ evicted: false });
	}, 20_000);

	it("refuses to evict a currently-registered workspace, surfacing the real RepoCacheEntryInUse error", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "pi-lector-repo-cache-evict-cache-"));
		const daemon = await startIsolatedLectorDaemon({
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const fetchOps = createLectorRepoFetchOperations();
		await fetchOps.fetch("local-fixture", "acme", "widgets", null);

		const evictOps = createRepoCacheEvictOperations();
		await expect(evictOps.evict("local-fixture", "acme", "widgets", null)).rejects.toThrow(/RepoCacheEntryInUse|still registered/);
	}, 20_000);
});
