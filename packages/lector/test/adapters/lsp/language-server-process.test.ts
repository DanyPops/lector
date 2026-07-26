/**
 * Subprocess lifecycle safety, proven against the evil mock server so each
 * failure mode is deterministic rather than timing-dependent against a
 * real language server.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcMessageLimitExceeded } from "../../../src/adapters/lsp/json-rpc-stream.ts";
import {
	LanguageServerCapacityExceeded,
	LanguageServerProcess,
	LanguageServerProcessExited,
	LanguageServerRequestTimedOut,
} from "../../../src/adapters/lsp/language-server-process.ts";

const EVIL_SERVER_PATH = fileURLToPath(new URL("../../support/evil-lsp-server.ts", import.meta.url));

let cwd: string | undefined;
let server: LanguageServerProcess | undefined;

afterEach(async () => {
	await server?.stop();
	server = undefined;
	if (cwd) rmSync(cwd, { recursive: true, force: true });
	cwd = undefined;
});

function spawnEvil(mode: string, requestTimeoutMs?: number, bounds: { maxPendingRequests?: number; maxMessageBytes?: number } = {}): LanguageServerProcess {
	cwd = mkdtempSync(join(tmpdir(), "lector-evil-lsp-"));
	server = LanguageServerProcess.spawnProcess({
		command: "bun",
		args: [EVIL_SERVER_PATH],
		cwd,
		env: { EVIL_LSP_MODE: mode },
		requestTimeoutMs,
		...bounds,
	});
	return server;
}

describe("LanguageServerProcess against a well-behaved mock", () => {
	it("completes a request/response round trip", async () => {
		const proc = spawnEvil("normal");
		const result = await proc.request<{ capabilities: unknown }>("initialize", {});
		expect(result).toEqual({ capabilities: {} });
	});

	it("onNotification is called with a server-pushed notification's params", async () => {
		const proc = spawnEvil("sends-notification");
		const received = new Promise<unknown>((resolve) => proc.onNotification("textDocument/publishDiagnostics", resolve));

		await proc.request("initialize", {});

		expect(await received).toEqual({ uri: "file:///fake.ts", diagnostics: [] });
	});

	it("onNotification's returned unsubscribe stops delivering to that handler", async () => {
		const proc = spawnEvil("sends-notification");
		let callCount = 0;
		const unsubscribe = proc.onNotification("textDocument/publishDiagnostics", () => {
			callCount++;
		});
		unsubscribe();

		await proc.request("initialize", {});
		await new Promise((resolve) => setTimeout(resolve, 100)); // let the notification arrive, if it were going to

		expect(callCount).toBe(0);
	});

	it("a notification with no registered handler is silently ignored, not thrown", async () => {
		const proc = spawnEvil("sends-notification");

		await expect(proc.request("initialize", {})).resolves.toEqual({ capabilities: {} });
	});

	it("stop() reaps the process (graceful shutdown path)", async () => {
		const proc = spawnEvil("normal");
		await proc.request("initialize", {});
		await proc.stop();
		// A second stop() must be a safe no-op, not hang or throw, regardless of how the
		// first one actually terminated the process.
		await expect(proc.stop()).resolves.toBeUndefined();
	});
});

describe("LanguageServerProcess against a hostile mock -- timeouts", () => {
	it("a request that hangs at initialize times out within roughly the configured budget, not forever", async () => {
		const proc = spawnEvil("hang-on-initialize", 200);
		const started = Date.now();
		await expect(proc.request("initialize", {})).rejects.toBeInstanceOf(LanguageServerRequestTimedOut);
		expect(Date.now() - started).toBeLessThan(200 * 4);
	});

	it("a request that hangs past initialize times out the same way", async () => {
		const proc = spawnEvil("hang-on-request", 200);
		await proc.request("initialize", {});
		const started = Date.now();
		await expect(proc.request("workspace/symbol", { query: "x" })).rejects.toBeInstanceOf(LanguageServerRequestTimedOut);
		expect(Date.now() - started).toBeLessThan(200 * 4);
	});

	it("stop() against a server that hangs on shutdown still completes within roughly its own timeout, via a hard kill", async () => {
		const proc = spawnEvil("hang-on-shutdown");
		await proc.request("initialize", {});
		const started = Date.now();
		await proc.stop(200);
		expect(Date.now() - started).toBeLessThan(200 * 4);
	});
});

describe("LanguageServerProcess resource bounds", () => {
	it("rejects excess concurrent requests instead of growing the pending map without bound", async () => {
		const proc = spawnEvil("hang-on-request", 100, { maxPendingRequests: 1 });
		await proc.request("initialize", {});
		const pending = proc.request("workspace/symbol", {});

		await expect(proc.request("workspace/symbol", {})).rejects.toBeInstanceOf(LanguageServerCapacityExceeded);
		await expect(pending).rejects.toBeInstanceOf(LanguageServerRequestTimedOut);
	});

	it("rejects an outbound request or notification beyond the message bound before writing it", async () => {
		const proc = spawnEvil("normal", 1_000, { maxMessageBytes: 512 });
		await proc.request("initialize", {});

		await expect(proc.request("workspace/symbol", { query: "x".repeat(1_000) })).rejects.toBeInstanceOf(JsonRpcMessageLimitExceeded);
		expect(() => proc.notify("textDocument/didOpen", { text: "x".repeat(1_000) })).toThrow(JsonRpcMessageLimitExceeded);
	});

	it("fails closed and kills a server whose response exceeds the message bound", async () => {
		const proc = spawnEvil("oversized-response", 1_000, { maxMessageBytes: 1_024 });
		await proc.request("initialize", {});

		await expect(proc.request("workspace/symbol", {})).rejects.toBeInstanceOf(JsonRpcMessageLimitExceeded);
		await expect(proc.request("workspace/symbol", {})).rejects.toBeInstanceOf(JsonRpcMessageLimitExceeded);
	});
});

describe("LanguageServerProcess against a process that dies mid-flight", () => {
	it("rejects an in-flight request immediately when the process exits, rather than hanging forever", async () => {
		const proc = spawnEvil("exit-after-initialize", 10_000); // deliberately long request timeout
		// The first request's response also triggers the server's own exit(1) right after
		// replying, so by the time this resolves the process is already on its way out.
		await proc.request("initialize", {});

		const started = Date.now();
		let caught: unknown;
		try {
			await proc.request("workspace/symbol", { query: "x" });
		} catch (error) {
			caught = error;
		}

		// Must reject promptly via the exit handler, not sit until the 10s request timeout fires.
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(caught).toBeInstanceOf(LanguageServerProcessExited);
	});

	it("a request made after the process already exited is rejected immediately, never silently queued", async () => {
		const proc = spawnEvil("exit-after-initialize");
		await proc.request("initialize", {});
		await new Promise((resolve) => setTimeout(resolve, 300)); // let the exit actually land

		const started = Date.now();
		await expect(proc.request("workspace/symbol", { query: "x" })).rejects.toBeInstanceOf(LanguageServerProcessExited);
		expect(Date.now() - started).toBeLessThan(50);
	});
});
