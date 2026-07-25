import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/daemon-kit/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { JobSnapshot, PopulateSymbolGraphResult } from "../src/index.ts";
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

function fixture(): string {
	fixtureRoot = mkdtempSync(join(tmpdir(), "lector-cli-job-"));
	writeFileSync(join(fixtureRoot, "index.ts"), "export function answer() { return 42; }\n");
	writeFileSync(join(fixtureRoot, "tsconfig.json"), "{}");
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

describe("lector CLI background-job parity", () => {
	it("submits populate-symbol-graph in the background and polls the same job through job status", async () => {
		isolated = isolatedLectorPaths();
		daemon = startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		const submitted = JSON.parse(
			await runCli([
				"workspace",
				"populate-symbol-graph",
				registered.workspaceId,
				"--max-files",
				"10",
				"--max-symbols-per-file",
				"10",
				"--background",
				"--wait-ms",
				"0",
				"--json",
			]),
		) as JobSnapshot<PopulateSymbolGraphResult>;
		expect(["queued", "running"]).toContain(submitted.status);
		expect(submitted.id.length).toBeGreaterThan(0);

		const polled = JSON.parse(await runCli(["job", "status", submitted.id, "--json"])) as JobSnapshot<PopulateSymbolGraphResult>;
		expect(polled.id).toBe(submitted.id);
		expect(["queued", "running", "succeeded"]).toContain(polled.status);
	}, 20_000);
});
