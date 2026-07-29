/**
 * End-to-end CLI parity for `lector workspace reference-based-rename`, against a real spawned
 * daemon, a real typescript-language-server, and real files on disk.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/daemon-kit/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { ReferenceBasedRenameOutcome } from "../src/index.ts";
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
	const root = mkdtempSync(join(tmpdir(), "lector-cli-reference-based-rename-"));
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

describe("lector CLI workspace reference-based-rename", () => {
	it("moves a real file, rewrites the real importing file's specifier, and round-trips through --json", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };
		await runCli(["workspace", "populate-symbol-graph", registered.workspaceId, "--max-files", "10", "--max-symbols-per-file", "10", "--json"]);

		const outcome = JSON.parse(
			await runCli([
				"workspace",
				"reference-based-rename",
				registered.workspaceId,
				join(project, "src", "math.ts"),
				join(project, "src", "arithmetic.ts"),
				"--max-files",
				"10",
				"--max-symbols-per-file",
				"10",
				"--json",
			]),
		) as ReferenceBasedRenameOutcome;

		expect(outcome.movedTo).toBe(join(project, "src", "arithmetic.ts"));
		expect(outcome.filesUpdated).toEqual([join(project, "src", "consumer.ts")]);
		expect(readFileSync(join(project, "src", "consumer.ts"), "utf8")).toContain('from "./arithmetic"');
	}, 20_000);
});
