/**
 * End-to-end CLI parity for `lector workspace repo-cache-list`, against a real spawned daemon
 * and a real local git repo standing in for "the remote" -- GitRepoFetcher's own correctness is
 * already covered directly in test/adapters/git-repo-fetcher.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/daemon-kit/daemon";
import { GitRepoFetcher } from "../src/adapters/git-repo-fetcher.ts";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
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
	const root = mkdtempSync(join(tmpdir(), "lector-cli-repo-cache-source-"));
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

describe("lector CLI workspace repo-cache-list", () => {
	it("reports an empty cache, then lists a fetched repo with host/owner/repo/ref and registration state -- round-trips through --json", async () => {
		isolated = isolatedLectorPaths();
		sourceRepo = buildSourceRepo();
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createRepoFetcher: () => new GitRepoFetcher(join(isolated?.root ?? "", "repos"), { resolveCloneUrl: () => sourceRepo as string }),
		});

		const empty = JSON.parse(await runCli(["workspace", "repo-cache-list", "--max-results", "10", "--json"])) as {
			entries: unknown[];
			nextCursor: string | null;
		};
		expect(empty).toEqual({ entries: [], nextCursor: null });

		await runCli(["workspace", "repo-fetch", "acme/widgets", "--host", "local-fixture", "--json"]);

		const page = JSON.parse(await runCli(["workspace", "repo-cache-list", "--max-results", "10", "--json"])) as {
			entries: Array<{ host: string; owner: string; repo: string; registeredWorkspaceId: string | null }>;
			nextCursor: string | null;
		};
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]).toMatchObject({ host: "local-fixture", owner: "acme", repo: "widgets" });
		expect(page.entries[0]?.registeredWorkspaceId).not.toBeNull();
	}, 20_000);
});
