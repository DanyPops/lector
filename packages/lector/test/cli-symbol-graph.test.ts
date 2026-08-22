/**
 * End-to-end CLI parity for workspace.reachableFrom's autoPopulate opt-in, against a real
 * spawned daemon and a real LSP-populated symbol graph.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { startLectorDaemon } from "../src/daemon.ts";
import type { SymbolNode } from "../src/index.ts";
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

function fixture(): string {
	fixtureRoot = mkdtempSync(join(tmpdir(), "lector-cli-symbol-graph-"));
	writeFileSync(join(fixtureRoot, "chain.ts"), "export function a(): number {\n\treturn b();\n}\n\nexport function b(): number {\n\treturn 1;\n}\n");
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

describe("lector CLI workspace symbol-graph reachable-from", () => {
	it("--auto-populate populates once and answers a real multi-hop question, with no manual populate-symbol-graph call", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };
		const path = join(project, "chain.ts");

		const symbols = JSON.parse(
			await runCli([
				"workspace",
				"symbol-graph",
				"reachable-from",
				registered.workspaceId,
				path,
				"1",
				"17",
				"--max-depth",
				"1",
				"--kind",
				"calls",
				"--auto-populate",
				"--max-files",
				"10",
				"--max-symbols-per-file",
				"10",
				"--json",
			]),
		) as SymbolNode[];

		expect(symbols.map((symbol) => symbol.name)).toContain("b");
	}, 30_000);
});
