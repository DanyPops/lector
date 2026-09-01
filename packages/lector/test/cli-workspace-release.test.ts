import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { startLectorDaemon } from "../src/daemon.ts";
import { InMemoryWorkspace } from "../src/workspace/in-memory-workspace.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let daemon: RunningDaemon | undefined;
let fixtureRoot: string | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;

afterEach(async () => {
	await daemon?.stop();
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	isolated?.cleanup();
	daemon = undefined;
	fixtureRoot = undefined;
	isolated = undefined;
});

async function runCli(args: readonly string[]): Promise<string> {
	if (!isolated) throw new Error("isolated daemon paths not initialized");
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
		env: { ...process.env, XDG_DATA_HOME: isolated.root, XDG_STATE_HOME: isolated.root, XDG_RUNTIME_DIR: isolated.root, XDG_CONFIG_HOME: isolated.root },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stderr}`);
	return stdout.trim();
}

describe("lector CLI workspace release", () => {
	it("releases by opaque workspace id and returns typed JSON", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		fixtureRoot = mkdtempSync(join(tmpdir(), "lector-cli-release-"));
		const registered = JSON.parse(await runCli(["workspace", "register", fixtureRoot, "--json"])) as { workspaceId: string };

		const released = JSON.parse(await runCli(["workspace", "release", registered.workspaceId, "--json"])) as {
			workspaceId: string;
			closedIndexes: number;
			closedGraph: boolean;
			closedWatch: boolean;
		};
		expect(released).toEqual({ workspaceId: registered.workspaceId, closedIndexes: 0, closedGraph: false, closedWatch: false });
	});
});
