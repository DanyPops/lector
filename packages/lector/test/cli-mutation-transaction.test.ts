/**
 * End-to-end CLI parity for `lector workspace mutation-transaction`/`revert-mutation-transaction`,
 * against a real spawned daemon, a real typescript-language-server, and real files on disk.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { startLectorDaemon } from "../src/daemon.ts";
import type { MutationHistoryEntry, MutationTransactionLookupOutcome } from "../src/index.ts";
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
	const root = mkdtempSync(join(tmpdir(), "lector-cli-mutation-transaction-"));
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

describe("lector CLI workspace mutation-transaction / revert-mutation-transaction", () => {
	it("a real rename's transaction previews across both touched files and reverts atomically -- both round-trip through --json", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };
		const unknown = JSON.parse(
			await runCli(["workspace", "mutation-transaction", registered.workspaceId, "never-recorded", "--json"]),
		) as MutationTransactionLookupOutcome;
		expect(unknown).toEqual({ status: "unknown", transactionId: "never-recorded" });

		const mathPath = join(project, "src", "math.ts");
		const consumerPath = join(project, "src", "consumer.ts");
		const originalMath = readFileSync(mathPath, "utf8");
		const originalConsumer = readFileSync(consumerPath, "utf8");
		// Warms consumer.ts into the same server session so its usage is included in the rename's edit.
		await runCli(["workspace", "document-symbols", registered.workspaceId, consumerPath, "--json"]);

		await runCli(["workspace", "rename", registered.workspaceId, mathPath, "1", "17", "sum", "--json"]);

		const history = JSON.parse(
			await runCli(["workspace", "mutation-history", registered.workspaceId, mathPath, "--max-results", "10", "--json"]),
		) as MutationHistoryEntry[];
		const transactionId = history[0]?.transactionId;
		expect(transactionId).toBeTruthy();

		const preview = JSON.parse(
			await runCli(["workspace", "mutation-transaction", registered.workspaceId, transactionId as string, "--json"]),
		) as MutationTransactionLookupOutcome;
		expect(preview.status).toBe("ready");
		if (preview.status === "ready") expect(preview.entries.map((entry) => entry.path).sort()).toEqual([consumerPath, mathPath].sort());

		const reverted = JSON.parse(await runCli(["workspace", "revert-mutation-transaction", registered.workspaceId, transactionId as string, "--json"])) as {
			reverted: readonly { path: string; newHash: string | null }[];
		};
		expect(reverted.reverted.map((entry) => entry.path).sort()).toEqual([consumerPath, mathPath].sort());
		expect(readFileSync(mathPath, "utf8")).toBe(originalMath);
		expect(readFileSync(consumerPath, "utf8")).toBe(originalConsumer);
	}, 20_000);
});
