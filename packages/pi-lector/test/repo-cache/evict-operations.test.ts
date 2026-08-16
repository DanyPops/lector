/**
 * repo_cache_evict against a real local git repository standing in for "the remote", injected
 * via the daemon's own createRepoFetcher override -- no live network, same discipline
 * repo-fetch-operations.test.ts already uses. Dispatches through the daemon's real Vehicle
 * protocol (/vehicle/manifest, /vehicle/invoke) -- see vehicle-client.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepoFetcher } from "@danypops/lector";
import { resetLectorClientForTests } from "../../extension/src/lector-client.ts";
import { createRepoCacheEvictOperations } from "../../extension/src/repo-cache/evict-operations.ts";
import { createLectorRepoFetchOperations } from "../../extension/src/repo-fetch/operations.ts";
import { resetLectorVehicleClientForTests } from "../../extension/src/vehicle-client.ts";
import { requireDefined } from "../support/require-defined.ts";
import { wireVehicleDaemon } from "../support/wire-vehicle-daemon.ts";

let sourceRepo: string | undefined;
let reposDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	resetLectorVehicleClientForTests();
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
		const daemon = await wireVehicleDaemon({
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		stopDaemon = daemon.stop;

		const evictOps = createRepoCacheEvictOperations();
		await expect(evictOps.evict("local-fixture", "acme", "widgets", null, await daemon.call("repo_cache"))).resolves.toEqual({ evicted: false });
	}, 20_000);

	it("refuses to evict a currently-registered workspace, surfacing the real RepoCacheEntryInUse error", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "pi-lector-repo-cache-evict-cache-"));
		const daemon = await wireVehicleDaemon({
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		stopDaemon = daemon.stop;

		const fetchOps = createLectorRepoFetchOperations();
		await fetchOps.fetch("local-fixture", "acme", "widgets", null, undefined, await daemon.call("repo_cache"));

		const evictOps = createRepoCacheEvictOperations();
		await expect(evictOps.evict("local-fixture", "acme", "widgets", null, await daemon.call("repo_cache"))).rejects.toThrow(
			/RepoCacheEntryInUse|still registered/,
		);
	}, 20_000);
});
