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
import { JsonRpcMessageLimitExceeded } from "../../../src/code-intelligence/lsp/json-rpc-stream.ts";
import {
	DuplicateRequestHandler,
	LanguageServerCapacityExceeded,
	LanguageServerProcess,
	LanguageServerProcessExited,
	LanguageServerRequestCanceled,
	LanguageServerRequestTimedOut,
} from "../../../src/code-intelligence/lsp/language-server-process.ts";

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

describe("LanguageServerProcess handling server-initiated requests", () => {
	it("answers every real server-initiated request with the registered handler's actual reply", async () => {
		const proc = spawnEvil("sends-server-request");
		const results: Array<{ step: string; result: unknown; error: unknown }> = [];
		const allStepsSeen = new Promise<void>((resolveAll) => {
			proc.onNotification("test/serverRequestResult", (params) => {
				results.push(params as { step: string; result: unknown; error: unknown });
				if (results.length === 8) resolveAll();
			});
		});

		proc.onRequest("client/registerCapability", () => null);
		proc.onRequest("client/unregisterCapability", () => null);
		proc.onRequest("workspace/configuration", (params) => (params as { items: unknown[] }).items.map(() => null));
		proc.onRequest("workspace/applyEdit", () => ({ applied: false, failureReason: "not supported" }));
		proc.onRequest("window/workDoneProgress/create", () => null);
		proc.onRequest("workspace/workspaceFolders", () => [{ uri: "file:///repo", name: "repo" }]);
		proc.onRequest("workspace/diagnostic/refresh", () => null);
		// window/showMessageRequest is deliberately left unregistered -- must come back as MethodNotFound.

		await proc.request("initialize", {});
		await allStepsSeen;

		const byStep = new Map(results.map((entry) => [entry.step, entry]));
		expect(byStep.get("register")).toEqual({ step: "register", result: null, error: null });
		expect(byStep.get("unregister")).toEqual({ step: "unregister", result: null, error: null });
		expect(byStep.get("configuration")).toEqual({ step: "configuration", result: [null, null], error: null });
		expect(byStep.get("applyEdit")).toEqual({ step: "applyEdit", result: { applied: false, failureReason: "not supported" }, error: null });
		expect(byStep.get("progressCreate")).toEqual({ step: "progressCreate", result: null, error: null });
		expect(byStep.get("workspaceFolders")).toEqual({ step: "workspaceFolders", result: [{ uri: "file:///repo", name: "repo" }], error: null });
		expect(byStep.get("diagnosticRefresh")).toEqual({ step: "diagnosticRefresh", result: null, error: null });
		const unsupported = byStep.get("unsupported");
		expect(unsupported?.result).toBeNull();
		expect(unsupported?.error).toMatchObject({ code: -32601 });
	});

	it("an unhandled server-initiated request answers MethodNotFound instead of hanging the server forever", async () => {
		const proc = spawnEvil("sends-server-request");
		const methodNotFound = new Promise<{ code: number; message: string }>((resolveResult) => {
			proc.onNotification("test/serverRequestResult", (params) => {
				const { step, error } = params as { step: string; error: { code: number; message: string } | null };
				if (step === "unsupported" && error) resolveResult(error);
			});
		});
		// Every other server-initiated request is left unhandled too in this test -- every one of
		// them must still get a reply (MethodNotFound), never silence, or this server would hang
		// waiting on "register" and never even reach "unsupported".

		await proc.request("initialize", {});
		const error = await methodNotFound;
		expect(error.code).toBe(-32601);
		expect(error.message).toContain("window/showMessageRequest");
	});

	it("a request handler that throws answers InternalError rather than leaving the server waiting", async () => {
		const proc = spawnEvil("sends-server-request");
		const registerResult = new Promise<{ error: { code: number; message: string } | null }>((resolveResult) => {
			proc.onNotification("test/serverRequestResult", (params) => {
				const entry = params as { step: string; error: { code: number; message: string } | null };
				if (entry.step === "register") resolveResult(entry);
			});
		});
		proc.onRequest("client/registerCapability", () => {
			throw new Error("deliberate handler failure");
		});

		await proc.request("initialize", {});
		const { error } = await registerResult;
		expect(error).toMatchObject({ code: -32603, message: "deliberate handler failure" });
	});

	it("onRequest refuses a second handler for the same method", () => {
		const proc = spawnEvil("normal");
		proc.onRequest("workspace/configuration", () => []);
		expect(() => proc.onRequest("workspace/configuration", () => [])).toThrow(DuplicateRequestHandler);
	});

	it("onRequest's returned unregister function stops answering, falling back to MethodNotFound", async () => {
		const proc = spawnEvil("sends-server-request");
		const unregister = proc.onRequest("client/registerCapability", () => null);
		unregister();
		const registerResult = new Promise<{ error: { code: number } | null }>((resolveResult) => {
			proc.onNotification("test/serverRequestResult", (params) => {
				const entry = params as { step: string; error: { code: number } | null };
				if (entry.step === "register") resolveResult(entry);
			});
		});

		await proc.request("initialize", {});
		const { error } = await registerResult;
		expect(error).toMatchObject({ code: -32601 });
	});
});

describe("LanguageServerProcess request cancellation", () => {
	it("aborting an outbound request's signal settles it immediately with LanguageServerRequestCanceled, not the timeout", async () => {
		const proc = spawnEvil("hang-on-request", 10_000); // deliberately long timeout -- must not be what settles this
		await proc.request("initialize", {});
		const controller = new AbortController();

		const started = Date.now();
		const pending = proc.request("workspace/symbol", { query: "x" }, { signal: controller.signal });
		controller.abort();

		await expect(pending).rejects.toBeInstanceOf(LanguageServerRequestCanceled);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it("an already-aborted signal rejects immediately without ever sending the request", async () => {
		const proc = spawnEvil("normal");
		await proc.request("initialize", {});
		const controller = new AbortController();
		controller.abort();

		await expect(proc.request("workspace/symbol", {}, { signal: controller.signal })).rejects.toBeInstanceOf(LanguageServerRequestCanceled);
	});

	it("a canceled request's slot is freed, not leaked -- capacity is available again immediately", async () => {
		const proc = spawnEvil("hang-on-request", 10_000, { maxPendingRequests: 1 });
		await proc.request("initialize", {});
		const controller = new AbortController();
		const pending = proc.request("workspace/symbol", {}, { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(LanguageServerRequestCanceled);

		// The capacity limit is 1 -- if the canceled slot were still counted as held, this next
		// request would reject with LanguageServerCapacityExceeded instead of being accepted (and
		// then just sitting pending, since this mock server hangs on every non-initialize request).
		const second = proc.request("workspace/symbol", {});
		const outcome = await Promise.race([
			second.then(() => "resolved").catch((error: unknown) => error),
			new Promise((resolve) => setTimeout(() => resolve("still-pending"), 100)),
		]);
		expect(outcome).toBe("still-pending");
	});

	it("canceling an outbound request actually notifies the server via $/cancelRequest", async () => {
		const proc = spawnEvil("hang-on-request", 10_000);
		const received = new Promise<{ id: number | string }>((resolve) => {
			proc.onNotification("test/cancelRequestReceived", (params) => resolve(params as { id: number | string }));
		});
		await proc.request("initialize", {});
		const controller = new AbortController();
		const pending = proc.request("workspace/symbol", {}, { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(LanguageServerRequestCanceled);

		const { id } = await received;
		expect(typeof id).toBe("number");
	});

	it("a server-initiated request the server itself cancels answers RequestCancelled, not the handler's real (now-stale) result", async () => {
		const proc = spawnEvil("cancels-own-request");
		const resultPromise = new Promise<{ result: unknown; error: { code: number; message: string } | null }>((resolve) => {
			proc.onNotification("test/serverRequestResult", (params) => resolve(params as { result: unknown; error: { code: number; message: string } | null }));
		});
		// The evil server sends $/cancelRequest immediately after issuing the request, well before
		// this handler's own 200ms delay elapses -- proving the cancellation actually overrides an
		// otherwise-successful in-flight reply, not just a fast-failing one.
		proc.onRequest("custom/cancelMe", async () => {
			await new Promise((resolve) => setTimeout(resolve, 200));
			return "should never reach the server -- request was canceled first";
		});

		await proc.request("initialize", {});
		const { result, error } = await resultPromise;
		expect(result).toBeNull();
		expect(error).toMatchObject({ code: -32800 });
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
		// Same rationale as the capacity test above: a generous process-level timeout so initialize's
		// own real-world latency can never be what times out, with the tight budget applied only to the
		// one request deliberately meant to hang.
		const proc = spawnEvil("hang-on-request", 10_000);
		await proc.request("initialize", {});
		const started = Date.now();
		await expect(proc.request("workspace/symbol", { query: "x" }, { timeoutMs: 200 })).rejects.toBeInstanceOf(LanguageServerRequestTimedOut);
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
		// A generous process-level timeout -- must not be what settles the initialize handshake, whose
		// own real-world latency (subprocess cold start) is unrelated to and can exceed a tight budget
		// (this exact coupling was a confirmed live flake: initialize itself sporadically timed out
		// under load before the evil server got a chance to respond). Only the request meant to hang
		// forever gets the tight per-call override.
		const proc = spawnEvil("hang-on-request", 10_000, { maxPendingRequests: 1 });
		await proc.request("initialize", {});
		const pending = proc.request("workspace/symbol", {}, { timeoutMs: 100 });

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
