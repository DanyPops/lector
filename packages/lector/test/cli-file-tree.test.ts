/**
 * CLI parity for the file-tree operations (listDirectory/createDirectory/renamePath/
 * deleteDirectory) -- every daemon operation must be reachable from the CLI, per the
 * daemon-tool-CLI-parity standard every other operation in this file already follows.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("lector CLI file-tree parity", () => {
	it("list-directory, create-directory, rename-path, and delete-directory all round-trip against a real registered workspace", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });

		projectRoot = mkdtempSync(join(tmpdir(), "lector-cli-file-tree-"));
		mkdirSync(join(projectRoot, "src"));
		writeFileSync(join(projectRoot, "readme.md"), "hello");

		const registered = await runCli(["workspace", "register", ".", "--json"], projectRoot);
		expect(registered.exitCode).toBe(0);
		const { workspaceId } = JSON.parse(registered.stdout) as { workspaceId: string };

		const initialList = await runCli(["workspace", "list-directory", workspaceId, "--json"], projectRoot);
		expect(initialList.exitCode).toBe(0);
		const initial = JSON.parse(initialList.stdout) as { entries: { name: string; kind: string }[] };
		expect(initial.entries.map((entry) => entry.name)).toEqual(["src", "readme.md"]);

		const created = await runCli(["workspace", "create-directory", workspaceId, "docs", "--json"], projectRoot);
		expect(created.exitCode).toBe(0);

		const renamed = await runCli(["workspace", "rename-path", workspaceId, "readme.md", "README.md", "--json"], projectRoot);
		expect(renamed.exitCode).toBe(0);
		expect(JSON.parse(renamed.stdout)).toEqual({ oldPath: "readme.md", newPath: "README.md" });

		const deleted = await runCli(["workspace", "delete-directory", workspaceId, "src", "--json"], projectRoot);
		expect(deleted.exitCode).toBe(0);

		const finalList = await runCli(["workspace", "list-directory", workspaceId, "--json"], projectRoot);
		const final = JSON.parse(finalList.stdout) as { entries: { name: string; kind: string }[] };
		expect(final.entries.map((entry) => entry.name)).toEqual(["docs", "README.md"]);
	});

	it("delete removes a single file, guarded by --expected-hash", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });

		projectRoot = mkdtempSync(join(tmpdir(), "lector-cli-delete-entry-"));
		writeFileSync(join(projectRoot, "doomed.txt"), "hello");

		const registered = await runCli(["workspace", "register", ".", "--json"], projectRoot);
		const { workspaceId } = JSON.parse(registered.stdout) as { workspaceId: string };

		const read = await runCli(["workspace", "read", workspaceId, "doomed.txt", "--json"], projectRoot);
		const { hash } = JSON.parse(read.stdout) as { hash: string };

		const deleted = await runCli(["workspace", "delete", workspaceId, "doomed.txt", "--expected-hash", hash, "--json"], projectRoot);
		expect(deleted.exitCode).toBe(0);

		const list = await runCli(["workspace", "list-directory", workspaceId, "--json"], projectRoot);
		const { entries } = JSON.parse(list.stdout) as { entries: { name: string }[] };
		expect(entries).toEqual([]);
	});

	it("list-directory's default (non-JSON) output marks directories with a trailing slash", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });

		projectRoot = mkdtempSync(join(tmpdir(), "lector-cli-file-tree-plain-"));
		mkdirSync(join(projectRoot, "src"));
		writeFileSync(join(projectRoot, "readme.md"), "hello");

		const registered = await runCli(["workspace", "register", ".", "--json"], projectRoot);
		const { workspaceId } = JSON.parse(registered.stdout) as { workspaceId: string };

		const list = await runCli(["workspace", "list-directory", workspaceId], projectRoot);
		expect(list.exitCode).toBe(0);
		expect(list.stdout.split("\n")).toEqual(["src/", "readme.md"]);
	});
});
