/**
 * Full real-daemon integration for workspace.watch: a real HTTP daemon, a real WebSocket
 * connection to its /push endpoint, a real registered workspace.watch, and a real filesystem
 * change -- proves the whole path (service -> PushChannel -> WebSocket -> subscriber) works
 * end to end, not just that each layer's own unit tests pass in isolation.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/daemon-kit/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { connectLectorClientAt } from "../src/client.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let daemon: RunningDaemon | undefined;
let projectRoot: string | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
	projectRoot = undefined;
	isolated?.cleanup();
	isolated = undefined;
});

describe("real daemon workspace.watch delivered over the real PushChannel WebSocket", () => {
	it("delivers a real file-change event to a real WebSocket subscriber", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		projectRoot = mkdtempSync(join(tmpdir(), "lector-daemon-watch-push-"));

		const token = readFileSync(isolated.paths.token, "utf8").trim();
		const client = connectLectorClientAt(`http://${daemon.host}:${daemon.port}`, token);
		const { workspaceId } = await client.call("workspace.registerPath", { path: projectRoot });
		const { topic } = await client.call("workspace.watch", { workspaceId, pattern: "*.ts" });

		const received: unknown[] = [];
		const ws = new WebSocket(`ws://${daemon.host}:${daemon.port}/push?token=${token}`);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
		});
		ws.addEventListener("message", (event) => {
			received.push(JSON.parse(String(event.data)));
		});
		ws.send(JSON.stringify({ op: "subscribe", topic }));
		// Let the subscribe message actually land server-side before triggering the change --
		// a real round trip, not assumed instantaneous.
		await new Promise((resolve) => setTimeout(resolve, 200));

		writeFileSync(join(projectRoot, "a.ts"), "export const x = 1;\n");

		await new Promise<void>((resolve, reject) => {
			const startedAt = Date.now();
			const check = () => {
				if (received.some((message) => (message as { topic?: string }).topic === topic)) return resolve();
				if (Date.now() - startedAt > 5000) return reject(new Error(`timed out; received: ${JSON.stringify(received)}`));
				setTimeout(check, 50);
			};
			check();
		});

		ws.close();
		const message = received.find((m) => (m as { topic?: string }).topic === topic) as { topic: string; payload: { path: string; kind: string } };
		expect(message.payload).toMatchObject({ path: "a.ts", kind: "created" });
	}, 20_000);
});
