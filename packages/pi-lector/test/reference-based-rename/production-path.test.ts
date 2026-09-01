import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import lectorExtension from "../../extension/src/index.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { resetLectorVehicleClientForTests, setLectorVehicleClientConnectorForTests } from "../../extension/src/vehicle-client.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

let root: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	resetLectorVehicleClientForTests();
	await stopDaemon?.();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	stopDaemon = undefined;
});

function fixture(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-lector-rename-production-"));
	mkdirSync(join(directory, "src"));
	writeFileSync(join(directory, "src", "math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
	writeFileSync(join(directory, "src", "consumer.ts"), 'import { add } from "./math";\nexport const total = add(1, 2);\n');
	writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
	execFileSync("git", ["init", "-q"], { cwd: directory });
	return directory;
}

describe("reference-based rename production path", () => {
	it("returns a transaction that mutation_history can revert directly", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		setLectorVehicleClientConnectorForTests(() => Promise.resolve(new RemoteVehicleClient({ baseUrl: daemon.baseUrl, token: daemon.token })));
		root = fixture();
		const resolved = await daemon.client.call("workspace.resolvePath", { strategy: "language-project-root", path: root, fallback: "given-directory" });
		if (!resolved.found) throw new Error("fixture workspace did not resolve");
		await daemon.client.call("workspace.populateSymbolGraph", { workspaceId: resolved.workspaceId, maxFiles: 10, maxSymbolsPerFile: 20 });
		const harness = createExtensionHarness(lectorExtension, { cwd: root });
		await harness.boot();
		const renameTool = harness.tools.get("reference_based_rename")?.definition;
		const historyTool = harness.tools.get("mutation_history")?.definition;
		if (!renameTool || !historyTool) throw new Error("required mutation tools were not registered");

		const renamed = await renameTool.execute(
			"rename-call",
			{ fromPath: join(root, "src", "math.ts"), toPath: join(root, "src", "arithmetic.ts"), maxFiles: 10, maxSymbolsPerFile: 20 },
			new AbortController().signal,
			() => {},
			harness.ctx,
		);
		const modelText = renamed.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		const match = modelText.match(/transaction ([^\s]+)/);
		expect(match?.[1]).toBeString();
		const transactionId = match?.[1];
		if (!transactionId) throw new Error("rename model content omitted transaction id");
		for (const path of [join(root, "src", "math.ts"), join(root, "src", "arithmetic.ts"), join(root, "src", "consumer.ts")]) {
			const history = await historyTool.execute(`list-${path}`, { action: "list", path, maxResults: 20 }, new AbortController().signal, () => {}, harness.ctx);
			const historyText = history.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			expect(historyText, path).toContain(transactionId);
		}

		await historyTool.execute(
			"revert-call",
			{ action: "revert-transaction", path: join(root, "src", "consumer.ts"), transactionId },
			new AbortController().signal,
			() => {},
			harness.ctx,
		);
		expect(existsSync(join(root, "src", "math.ts"))).toBe(true);
		expect(existsSync(join(root, "src", "arithmetic.ts"))).toBe(false);
		expect(readFileSync(join(root, "src", "consumer.ts"), "utf8")).toContain('from "./math"');
	}, 30_000);
});
