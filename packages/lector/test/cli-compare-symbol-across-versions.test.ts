/**
 * End-to-end CLI parity for `lector workspace compare-symbol`, against a real spawned daemon
 * and a real git repository -- no LSP/checkout involved (the tree-sitter syntactic tier).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { OperationOutputs } from "../src/index.ts";
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

function headSha(cwd: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
}

function fixture(): string {
	fixtureRoot = mkdtempSync(join(tmpdir(), "lector-cli-compare-symbol-"));
	git(fixtureRoot, "init", "-q");
	git(fixtureRoot, "config", "user.email", "t@t.com");
	git(fixtureRoot, "config", "user.name", "t");
	return fixtureRoot;
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

describe("lector CLI workspace compare-symbol", () => {
	it("reports a real unified diff for a symbol changed between two commits", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		writeFileSync(join(project, "a.ts"), "export function greet() {\n\treturn 'hi';\n}\n");
		git(project, "add", "a.ts");
		git(project, "commit", "-q", "-m", "v1");
		const v1 = headSha(project);
		writeFileSync(join(project, "a.ts"), "export function greet() {\n\treturn 'hello';\n}\n");
		git(project, "add", "a.ts");
		git(project, "commit", "-q", "-m", "v2");
		const v2 = headSha(project);

		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };
		const result = JSON.parse(
			await runCli([
				"workspace",
				"compare-symbol",
				registered.workspaceId,
				"--path",
				"a.ts",
				"--symbol",
				"greet",
				"--from-ref",
				v1,
				"--to-ref",
				v2,
				"--max-bytes",
				"10000",
				"--json",
			]),
		) as OperationOutputs["workspace.compareSymbolAcrossVersions"];

		expect(result.status).toBe("changed");
		expect(result.diff).toContain("-\treturn 'hi';");
		expect(result.diff).toContain("+\treturn 'hello';");
	});
});
