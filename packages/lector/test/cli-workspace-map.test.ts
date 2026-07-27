/**
 * End-to-end CLI parity for `lector workspace map`, against a real spawned
 * daemon and a real LSP-populated symbol graph.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/daemon-kit/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { WorkspaceMapResult } from "../src/index.ts";
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
	fixtureRoot = mkdtempSync(join(tmpdir(), "lector-cli-map-"));
	writeFileSync(
		join(fixtureRoot, "index.ts"),
		"export function central(): number {\n\treturn 1;\n}\n\nexport function a(): number {\n\treturn central();\n}\n\nexport function b(): number {\n\treturn central();\n}\n",
	);
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

describe("lector CLI workspace map", () => {
	it("ranks a real LSP-populated graph and bounds the result to --max-entries", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };
		await runCli(["workspace", "populate-symbol-graph", registered.workspaceId, "--max-files", "10", "--max-symbols-per-file", "10", "--json"]);

		const result = JSON.parse(
			await runCli([
				"workspace",
				"map",
				registered.workspaceId,
				"--max-nodes",
				"1000",
				"--max-edges",
				"1000",
				"--max-entries",
				"1",
				"--max-bytes",
				"1000000",
				"--json",
			]),
		) as WorkspaceMapResult;

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.name).toBe("central");
		expect(result.truncated).toBe(true);
	});
});
