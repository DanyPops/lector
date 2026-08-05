/**
 * End-to-end CLI parity for `lector workspace prepare-rename` and `lector workspace rename`,
 * against a real spawned daemon, a real typescript-language-server, and real files on disk.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	daemon = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
	isolated?.cleanup();
	isolated = undefined;
});

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-cli-rename-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "math.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	writeFileSync(join(root, "src", "consumer.ts"), 'import { add } from "./math";\n\nadd(1, 2);\n');
	writeFileSync(
		join(root, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
	);
	fixtureRoot = root;
	return root;
}

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

describe("lector CLI workspace prepare-rename / rename", () => {
	it("prepare-rename reports a real renameable range, and rename applies the edit atomically -- both round-trip through --json", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };
		const mathPath = join(project, "src", "math.ts");

		const prepared = JSON.parse(await runCli(["workspace", "prepare-rename", registered.workspaceId, mathPath, "1", "17", "--json"])) as {
			range: { placeholder: string | undefined } | null;
		};
		expect(prepared.range).not.toBeNull();

		const renamed = JSON.parse(await runCli(["workspace", "rename", registered.workspaceId, mathPath, "1", "17", "sum", "--json"])) as {
			touchedPaths: readonly string[];
		};

		expect(renamed.touchedPaths).toContain(mathPath);
		expect(readFileSync(mathPath, "utf8")).toContain("export function sum");
	}, 20_000);
});
