/**
 * The read tool override, built from pi-mono's own createReadToolDefinition
 * + Lector-backed ReadOperations, returns real content from a running
 * Lector daemon -- exercised through the actual built-in factory, not just
 * the Operations object in isolation.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { createLectorReadOperations } from "../../extension/src/read/operations.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

let projectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	projectDir = undefined;
});

describe("Lector-backed read tool", () => {
	it("returns the real content of a file registered from the tool's cwd", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-read-"));
		writeFileSync(join(projectDir, "hello.txt"), "hello from a real Lector-backed read tool");

		const tool = createReadToolDefinition(projectDir, { operations: createLectorReadOperations() });
		const result = await tool.execute("call-1", { path: "hello.txt" }, undefined, undefined, {
			cwd: projectDir,
		} as never);

		const text = (result.content[0] as TextContent).text;
		expect(text).toContain("hello from a real Lector-backed read tool");
	});
});
