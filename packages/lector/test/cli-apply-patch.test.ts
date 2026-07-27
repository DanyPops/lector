/**
 * End-to-end CLI parity for `workspace apply-patch`, against a real spawned daemon -- proves
 * the CLI's --patch/--expected-hash flags, the daemon's operation dispatch, and the real
 * unified-diff hunk-matching all agree, not just that each layer typechecks alone.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/daemon-kit/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import { contentHashOf } from "../src/domain/content-hash.ts";
import type { EditOutcome } from "../src/index.ts";
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

const CONTENT = "line 1\nline 2\nline 3\n";

function fixture(): string {
	projectRoot = mkdtempSync(join(tmpdir(), "lector-cli-apply-patch-"));
	writeFileSync(join(projectRoot, "a.ts"), CONTENT);
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

describe("lector CLI apply-patch", () => {
	it("applies a real unified diff end to end", async () => {
		isolated = isolatedLectorPaths();
		daemon = startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		const patch = "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line 2 patched\n line 3\n";
		const result = JSON.parse(
			await runCli(["workspace", "apply-patch", registered.workspaceId, "a.ts", "--patch", patch, "--expected-hash", contentHashOf(CONTENT), "--json"]),
		) as EditOutcome;

		expect(result.path).toBe("a.ts");
		const read = JSON.parse(await runCli(["workspace", "read", registered.workspaceId, "a.ts", "--json"])) as { content: string };
		expect(read.content).toBe("line 1\nline 2 patched\nline 3\n");
	});

	it("rejects a stale expected hash with a non-zero exit, without writing anything", async () => {
		isolated = isolatedLectorPaths();
		daemon = startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		const patch = "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line 2 patched\n line 3\n";
		await expect(
			runCli(["workspace", "apply-patch", registered.workspaceId, "a.ts", "--patch", patch, "--expected-hash", contentHashOf("wrong content"), "--json"]),
		).rejects.toThrow();

		const read = JSON.parse(await runCli(["workspace", "read", registered.workspaceId, "a.ts", "--json"])) as { content: string };
		expect(read.content).toBe(CONTENT);
	});

	it("requires both --patch and --expected-hash, with a non-zero exit", async () => {
		isolated = isolatedLectorPaths();
		daemon = startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		await expect(runCli(["workspace", "apply-patch", registered.workspaceId, "a.ts", "--json"])).rejects.toThrow();
	});
});
