/** End-to-end CLI parity for `lector workspace mutation-history`/`revert-mutation`, against a real spawned daemon. */
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import { contentHashOf } from "../src/domain/content-hash.ts";
import type { MutationHistoryEntry } from "../src/index.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let daemon: RunningDaemon | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	isolated?.cleanup();
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

describe("lector CLI mutation-history/revert-mutation", () => {
	it("records real edits and reverts one via the daemon, round-tripping through --json", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["ws", new InMemoryWorkspace()]]), paths: isolated.paths });

		await runCli(["workspace", "edit", "ws", "a.txt", "--content", "v1", "--create", "--json"]);
		const editResult = JSON.parse(await runCli(["workspace", "edit", "ws", "a.txt", "--content", "v2", "--expected-hash", contentHashOf("v1"), "--json"])) as {
			newHash: string;
		};

		const entries = JSON.parse(await runCli(["workspace", "mutation-history", "ws", "a.txt", "--max-results", "10", "--json"])) as MutationHistoryEntry[];
		expect(entries).toHaveLength(2);
		const secondEntry = entries.find((entry) => entry.afterHash === editResult.newHash);
		expect(secondEntry).toBeDefined();

		const reverted = JSON.parse(await runCli(["workspace", "revert-mutation", "ws", secondEntry?.id as string, "--json"])) as { path: string; newHash: string };
		expect(reverted.newHash).toBe(contentHashOf("v1"));

		const content = await runCli(["workspace", "read", "ws", "a.txt", "--json"]);
		expect(JSON.parse(content)).toMatchObject({ content: "v1" });
	});
});
