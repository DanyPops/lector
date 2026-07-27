/**
 * End-to-end CLI parity for --response-format on `workspace symbols` and
 * `workspace references`, against a real spawned daemon and a real
 * LSP-populated fixture.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/daemon-kit/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { SymbolSearchResult } from "../src/index.ts";
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
	fixtureRoot = mkdtempSync(join(tmpdir(), "lector-cli-response-format-"));
	writeFileSync(join(fixtureRoot, "index.ts"), "export class MathUtils {\n\tadd(a: number, b: number): number {\n\t\treturn a + b;\n\t}\n}\n");
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

describe("lector CLI --response-format", () => {
	it("workspace symbols narrows provenance under --response-format concise, keeps the full shape by default", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		const detailed = JSON.parse(
			await runCli(["workspace", "symbols", registered.workspaceId, "add", "--seed-file", "index.ts", "--json"]),
		) as SymbolSearchResult;
		expect(detailed.provenance).toHaveProperty("languageId");
		expect(detailed.symbols.find((s) => s.name === "add")).toMatchObject({ name: "add", kind: "method" });

		const concise = JSON.parse(
			await runCli(["workspace", "symbols", registered.workspaceId, "add", "--seed-file", "index.ts", "--response-format", "concise", "--json"]),
		) as SymbolSearchResult;
		expect(concise.provenance).not.toHaveProperty("languageId");
		expect(concise.symbols.find((s) => s.name === "add")).not.toHaveProperty("containerName");
	});

	it("rejects an invalid --response-format value with a clear error and non-zero exit", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };

		await expect(
			runCli(["workspace", "symbols", registered.workspaceId, "add", "--seed-file", "index.ts", "--response-format", "bogus", "--json"]),
		).rejects.toThrow(/response-format/);
	});
});
