import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import lectorExtension from "../../extension/src/index.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

let root: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	stopDaemon = undefined;
});

function project(name: string, functionName: string): string {
	if (!root) throw new Error("fixture root not initialized");
	const directory = join(root, name);
	mkdirSync(join(directory, "src"), { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name, private: true }));
	writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
	writeFileSync(join(directory, "src", "index.ts"), `export function ${functionName}(): number { return 1; }\n`);
	return directory;
}

describe("cross-project model content production path", () => {
	it("keeps concrete nested symbols in registered tool output", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		root = mkdtempSync(join(tmpdir(), "pi-lector-cross-model-"));
		const alpha = project("alpha", "alphaNeedle");
		const beta = project("beta", "betaNeedle");
		const harness = createExtensionHarness(lectorExtension, { cwd: root });
		await harness.boot();
		const tool = harness.tools.get("find_symbols_across_projects")?.definition;
		if (!tool) throw new Error("find_symbols_across_projects was not registered");

		const result = await tool.execute(
			"cross-call",
			{ directories: [alpha, beta], query: "Needle", timeoutMs: 10_000, maxResults: 10 },
			new AbortController().signal,
			() => {},
			harness.ctx,
		);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("alphaNeedle");
		expect(text).toContain("betaNeedle");
		expect(text).not.toContain("[nested value omitted]");
	}, 30_000);
});
