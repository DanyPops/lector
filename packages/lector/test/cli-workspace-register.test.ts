/**
 * Real end-to-end proof of the RelativeWorkspacePath fix: `lector workspace register .` (or
 * any other relative input) must resolve against the CLI PROCESS's own cwd -- the only process
 * that actually knows what the invoking shell meant -- not the long-running daemon's own,
 * unrelated cwd. Spawns the CLI as a real subprocess with an explicit, controlled cwd distinct
 * from the daemon's, so this is provable rather than assumed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
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

async function runCli(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (!isolated) throw new Error("isolated daemon paths not initialized");
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
		cwd,
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
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("lector CLI workspace register -- relative path resolution", () => {
	it("resolves '.' against the CLI's own cwd, not the daemon's, even though they genuinely differ", async () => {
		isolated = isolatedLectorPaths();
		// The daemon's own cwd is wherever THIS test process happens to run (e.g. the repo root)
		// -- deliberately different from the project directory the CLI subprocess is spawned
		// into below, so a bug that resolved against the daemon's cwd instead of the CLI's own
		// would register the wrong directory and this test would catch it.
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });

		projectRoot = mkdtempSync(join(tmpdir(), "lector-cli-register-"));
		writeFileSync(join(projectRoot, "marker.ts"), "export const marker = 1;\n");

		const registered = await runCli(["workspace", "register", ".", "--json"], projectRoot);
		expect(registered.exitCode).toBe(0);
		const { workspaceId } = JSON.parse(registered.stdout) as { workspaceId: string };

		// Proves the registered root is genuinely projectRoot (and not e.g. the daemon's own
		// cwd) by reading a file that only exists there through the registered workspace.
		const read = await runCli(["workspace", "read", workspaceId, "marker.ts", "--json"], projectRoot);
		expect(read.exitCode).toBe(0);
		const { content } = JSON.parse(read.stdout) as { content: string };
		expect(content).toBe("export const marker = 1;\n");
	});

	it("a relative (non-'.') directory argument also resolves against the CLI's own cwd", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });

		const parent = mkdtempSync(join(tmpdir(), "lector-cli-register-parent-"));
		projectRoot = parent;
		writeFileSync(join(parent, "in-parent.ts"), "export const x = 1;\n");

		const registered = await runCli(["workspace", "register", ".", "--json"], parent);
		const { workspaceId } = JSON.parse(registered.stdout) as { workspaceId: string };
		const read = await runCli(["workspace", "read", workspaceId, "in-parent.ts", "--json"], parent);
		expect(read.exitCode).toBe(0);
	});
});
