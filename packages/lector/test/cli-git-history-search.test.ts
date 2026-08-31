import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { startLectorDaemon } from "../src/daemon.ts";
import type { OperationOutputs } from "../src/index.ts";
import { InMemoryWorkspace } from "../src/workspace/in-memory-workspace.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let daemon: RunningDaemon | undefined;
let fixtureRoot: string | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
	isolated?.cleanup();
	isolated = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

async function runCli(args: readonly string[]): Promise<string> {
	if (!isolated) throw new Error("isolated daemon paths not initialized");
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
		env: {
			...process.env,
			XDG_DATA_HOME: isolated.root,
			XDG_STATE_HOME: isolated.root,
			XDG_RUNTIME_DIR: isolated.root,
			XDG_CONFIG_HOME: isolated.root,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stderr}`);
	return stdout.trim();
}

describe("lector CLI workspace git-grep-history", () => {
	it("returns bounded historical matches from a real daemon", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		fixtureRoot = mkdtempSync(join(tmpdir(), "lector-cli-git-history-"));
		git(fixtureRoot, "init", "-q", "--initial-branch=main");
		git(fixtureRoot, "config", "user.email", "t@t.com");
		git(fixtureRoot, "config", "user.name", "t");
		writeFileSync(join(fixtureRoot, "a.ts"), "export const historicalNeedle = 1;\n");
		git(fixtureRoot, "add", "a.ts");
		git(fixtureRoot, "commit", "-q", "-m", "historical");
		writeFileSync(join(fixtureRoot, "a.ts"), "export const currentValue = 1;\n");
		git(fixtureRoot, "commit", "-qam", "current");

		const registered = JSON.parse(await runCli(["workspace", "register", fixtureRoot, "--json"])) as { workspaceId: string };
		const result = JSON.parse(
			await runCli([
				"workspace",
				"git-grep-history",
				registered.workspaceId,
				"historicalNeedle",
				"--commit-offset",
				"0",
				"--max-commits",
				"20",
				"--max-matches",
				"20",
				"--max-bytes",
				"20000",
				"--deadline-ms",
				"5000",
				"--pathspec",
				"*.ts",
				"--json",
			]),
		) as OperationOutputs["workspace.gitGrepHistory"];

		expect(result.matches).toContainEqual(expect.objectContaining({ path: "a.ts", line: 1, text: "export const historicalNeedle = 1;" }));
		expect(result.provenance.scope).toBe("all-refs");
	});
});
