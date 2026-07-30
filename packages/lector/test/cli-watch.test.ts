/**
 * End-to-end CLI parity for `workspace watch`/`unwatch`, against a real spawned daemon and a
 * real, long-running `lector workspace watch` subprocess -- proves the CLI's own WebSocket
 * subscription, the daemon's PushChannel, and a real filesystem change all agree.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let daemon: RunningDaemon | undefined;
let projectRoot: string | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;
let watchProcess: ReturnType<typeof Bun.spawn> | undefined;

afterEach(async () => {
	watchProcess?.kill();
	watchProcess = undefined;
	await daemon?.stop();
	daemon = undefined;
	if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
	projectRoot = undefined;
	isolated?.cleanup();
	isolated = undefined;
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

async function readLine(stream: ReadableStream<Uint8Array>, timeoutMs = 5000): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const startedAt = Date.now();
	try {
		while (true) {
			if (buffer.includes("\n")) return buffer.slice(0, buffer.indexOf("\n"));
			if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for a line; buffer so far: ${JSON.stringify(buffer)}`);
			const { value, done } = await Promise.race([
				reader.read(),
				new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 100)),
			]);
			if (done && !value) continue;
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
		}
		return buffer;
	} finally {
		reader.releaseLock();
	}
}

describe("lector CLI watch", () => {
	it("prints a real matching file change as it happens", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		projectRoot = mkdtempSync(join(tmpdir(), "lector-cli-watch-"));
		const registered = JSON.parse(await runCli(["workspace", "register", projectRoot, "--json"])) as { workspaceId: string };

		watchProcess = Bun.spawn(
			[process.execPath, join(import.meta.dir, "../src/cli.ts"), "workspace", "watch", registered.workspaceId, "--pattern", "*.ts", "--json"],
			{
				env: {
					...process.env,
					XDG_DATA_HOME: isolated.root,
					XDG_STATE_HOME: isolated.root,
					XDG_RUNTIME_DIR: isolated.root,
					XDG_CONFIG_HOME: isolated.root,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		// Give the subprocess real time to connect and subscribe before triggering the change.
		await new Promise((resolve) => setTimeout(resolve, 500));
		writeFileSync(join(projectRoot, "a.ts"), "export const x = 1;\n");

		const line = await readLine(watchProcess.stdout as ReadableStream<Uint8Array>);
		const event = JSON.parse(line) as { path: string; kind: string };
		expect(event).toMatchObject({ path: "a.ts", kind: "created" });
	}, 20_000);
});
