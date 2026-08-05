/**
 * End-to-end CLI parity for `lector workspace repo-cache-evict` and `repo-fetch --force-refresh`,
 * against a real spawned daemon and a real local git repo standing in for "the remote" --
 * GitRepoFetcher's own evict/forceRefresh correctness is already covered directly in
 * test/repo-fetcher/git-repo-fetcher.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { startLectorDaemon } from "../src/daemon.ts";
import { GitRepoFetcher } from "../src/repo-fetcher/git-repo-fetcher.ts";
import { InMemoryWorkspace } from "../src/workspace/in-memory-workspace.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let daemon: RunningDaemon | undefined;
let sourceRepo: string | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	if (sourceRepo) rmSync(sourceRepo, { recursive: true, force: true });
	sourceRepo = undefined;
	isolated?.cleanup();
	isolated = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildSourceRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-cli-repo-evict-source-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "README.md"), "hello\n");
	git(root, "add", "README.md");
	git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

async function runCli(args: readonly string[]): Promise<string> {
	if (!isolated) throw new Error("isolated daemon paths not initialized");
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
		env: { ...process.env, XDG_DATA_HOME: isolated.root, XDG_STATE_HOME: isolated.root, XDG_RUNTIME_DIR: isolated.root, XDG_CONFIG_HOME: isolated.root },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stderr}`);
	return stdout.trim();
}

describe("lector CLI workspace repo-cache-evict", () => {
	// A successful eviction of a genuinely cached, never-registered entry is already covered
	// directly at the adapter (git-repo-fetcher.test.ts) and service (service-repo-fetch.test.ts)
	// layers. It isn't retested end-to-end through a spawned daemon here: the daemon's own
	// GitRepoFetcher instance holds its cache in memory and never re-reads index.json written by a
	// second, separate GitRepoFetcher instance in this test process, and the only public path to
	// populate the daemon's real cache (repo.fetch) always registers a workspace -- so "cached but
	// not registered" has no way to arise through the CLI/daemon surface at all, by design.
	it("reports nothing cached for a never-fetched reference -- round-trips through --json", async () => {
		isolated = isolatedLectorPaths();
		sourceRepo = buildSourceRepo();
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createRepoFetcher: () => new GitRepoFetcher(join(isolated?.root ?? "", "repos"), { resolveCloneUrl: () => sourceRepo as string }),
		});

		const before = JSON.parse(await runCli(["workspace", "repo-cache-evict", "acme/widgets", "--host", "local-fixture", "--json"])) as { evicted: boolean };
		expect(before).toEqual({ evicted: false });
	}, 20_000);

	it("refuses via the CLI (non-zero exit, clear message) to evict a currently-registered workspace", async () => {
		isolated = isolatedLectorPaths();
		sourceRepo = buildSourceRepo();
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createRepoFetcher: () => new GitRepoFetcher(join(isolated?.root ?? "", "repos"), { resolveCloneUrl: () => sourceRepo as string }),
		});
		await runCli(["workspace", "repo-fetch", "acme/widgets", "--host", "local-fixture", "--json"]);

		await expect(runCli(["workspace", "repo-cache-evict", "acme/widgets", "--host", "local-fixture", "--json"])).rejects.toThrow(
			/RepoCacheEntryInUse|still registered/,
		);
	}, 20_000);
});

describe("lector CLI workspace repo-fetch --force-refresh", () => {
	it("reclones on --force-refresh even though an unexpired cache entry already exists", async () => {
		isolated = isolatedLectorPaths();
		sourceRepo = buildSourceRepo();
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createRepoFetcher: () => new GitRepoFetcher(join(isolated?.root ?? "", "repos"), { resolveCloneUrl: () => sourceRepo as string }),
		});
		const first = JSON.parse(await runCli(["workspace", "repo-fetch", "acme/widgets", "--host", "local-fixture", "--json"])) as {
			fromCache: boolean;
			commit: string;
		};
		expect(first.fromCache).toBe(false);
		git(sourceRepo, "commit", "-q", "--allow-empty", "-m", "a new commit on the remote");

		const withoutForce = JSON.parse(await runCli(["workspace", "repo-fetch", "acme/widgets", "--host", "local-fixture", "--json"])) as { fromCache: boolean };
		expect(withoutForce.fromCache).toBe(true);

		const withForce = JSON.parse(await runCli(["workspace", "repo-fetch", "acme/widgets", "--host", "local-fixture", "--force-refresh", "--json"])) as {
			fromCache: boolean;
			commit: string;
		};
		expect(withForce.fromCache).toBe(false);
		expect(withForce.commit).not.toBe(first.commit);
	}, 20_000);
});
