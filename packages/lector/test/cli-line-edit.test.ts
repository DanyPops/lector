/**
 * End-to-end CLI parity for `workspace line-edit`, against a real spawned daemon -- proves the
 * CLI's --edits JSON parsing, the daemon's operation dispatch, and the real domain function all
 * agree, not just that each layer typechecks alone.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { lineHashOf } from "../src/content-identity/line-hash.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { LineEditOutcome } from "../src/index.ts";
import { InMemoryWorkspace } from "../src/workspace/in-memory-workspace.ts";
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
	projectRoot = mkdtempSync(join(tmpdir(), "lector-cli-line-edit-"));
	writeFileSync(join(projectRoot, "a.ts"), "line 1\nline 2\nline 3\n");
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

describe("lector CLI line-edit", () => {
	it("replaces a single hash-guarded line end to end", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		const edits = [
			{ kind: "replace", startLine: 2, endLine: 2, expectedStartHash: lineHashOf("line 2"), expectedEndHash: lineHashOf("line 2"), lines: ["replaced"] },
		];
		const result = JSON.parse(
			await runCli(["workspace", "line-edit", registered.workspaceId, "a.ts", "--edits", JSON.stringify(edits), "--json"]),
		) as LineEditOutcome;

		expect(result.path).toBe("a.ts");
		const read = JSON.parse(await runCli(["workspace", "read", registered.workspaceId, "a.ts", "--json"])) as { content: string };
		expect(read.content).toBe("line 1\nreplaced\nline 3\n");
	});

	it("rejects a stale hash with a non-zero exit, without writing anything", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		const edits = [
			{ kind: "replace", startLine: 2, endLine: 2, expectedStartHash: lineHashOf("wrong content"), expectedEndHash: lineHashOf("wrong content"), lines: ["x"] },
		];
		await expect(runCli(["workspace", "line-edit", registered.workspaceId, "a.ts", "--edits", JSON.stringify(edits), "--json"])).rejects.toThrow();

		const read = JSON.parse(await runCli(["workspace", "read", registered.workspaceId, "a.ts", "--json"])) as { content: string };
		expect(read.content).toBe("line 1\nline 2\nline 3\n");
	});

	it("requires --edits, with a non-zero exit", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		await expect(runCli(["workspace", "line-edit", registered.workspaceId, "a.ts", "--json"])).rejects.toThrow();
	});
});
