import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { startLectorDaemon } from "../src/daemon.ts";
import type { TextSearchResult } from "../src/text-search/text-search-result.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let daemon: RunningDaemon | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;
let root: string | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	isolated?.cleanup();
	isolated = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

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

describe("indexed lexical search CLI parity", () => {
	it("reports lexical backend and index state in JSON and human output", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-cli-indexed-search-"));
		writeFileSync(join(root, "a.ts"), "export const searchableNeedle = 1;\n");
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map(), allowDynamicOnly: true, paths: isolated.paths });
		const registration = JSON.parse(await runCli(["workspace", "register", root, "--json"])) as { workspaceId: string };
		const human = await runCli(["workspace", "search-text", registration.workspaceId, "searchableNeedle", "--max-matches", "10", "--max-bytes", "10000"]);
		expect(human).toMatch(/lexical via (ripgrep|fff) \((loading|stale|ready|degraded)\)/);
		const json = JSON.parse(
			await runCli(["workspace", "search-text", registration.workspaceId, "searchableNeedle", "--max-matches", "11", "--max-bytes", "10000", "--json"]),
		) as TextSearchResult;
		expect(json.provenance?.kind).toBe("lexical");
		expect(json.matches[0]?.path).toBe("a.ts");
	}, 30_000);
});
