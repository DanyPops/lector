/**
 * End-to-end CLI parity for `workspace find-files`, against a real spawned daemon and real
 * ripgrep -- proves the CLI's --pattern flag collection, the daemon's operation dispatch, and
 * the real RipgrepTextSearch backend all agree, not just that each layer typechecks alone.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/daemon-kit/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { FindFilesResult } from "../src/index.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let daemon: RunningDaemon | undefined;
let projectRoot: string | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
	projectRoot = undefined;
	isolated?.cleanup();
	isolated = undefined;
});

function fixture(): string {
	projectRoot = mkdtempSync(join(tmpdir(), "lector-cli-find-files-"));
	mkdirSync(join(projectRoot, "src"));
	writeFileSync(join(projectRoot, "src", "index.ts"), "export const x = 1;\n");
	writeFileSync(join(projectRoot, "src", "index.test.ts"), "// test\n");
	writeFileSync(join(projectRoot, "README.md"), "# doc\n");
	return projectRoot;
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

describe("lector CLI find-files", () => {
	it("lists real files matching a single glob pattern", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		const result = JSON.parse(
			await runCli(["workspace", "find-files", registered.workspaceId, "--pattern", "*.ts", "--max-results", "100", "--max-bytes", "10000", "--json"]),
		) as FindFilesResult;

		expect([...result.paths].sort()).toEqual(["src/index.test.ts", "src/index.ts"]);
		expect(result.truncated).toBe(false);
	});

	it("OR's multiple --pattern flags together", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		const result = JSON.parse(
			await runCli([
				"workspace",
				"find-files",
				registered.workspaceId,
				"--pattern",
				"*.md",
				"--pattern",
				"*.test.ts",
				"--max-results",
				"100",
				"--max-bytes",
				"10000",
				"--json",
			]),
		) as FindFilesResult;

		expect([...result.paths].sort()).toEqual(["README.md", "src/index.test.ts"]);
	});

	it("requires at least one --pattern, with a non-zero exit", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		await expect(runCli(["workspace", "find-files", registered.workspaceId, "--max-results", "100", "--max-bytes", "10000", "--json"])).rejects.toThrow();
	});
});
