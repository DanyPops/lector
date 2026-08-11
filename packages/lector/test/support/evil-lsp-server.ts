#!/usr/bin/env bun
/**
 * A minimal, deliberately hostile LSP server for deterministic subprocess
 * lifecycle tests, so timeout/kill/reader-death behavior can be proven
 * without depending on timing against a real, well-behaved language server.
 *
 * Mode is read from the EVIL_LSP_MODE env var:
 *   normal               responds to everything correctly
 *   hang-on-initialize   never responds to `initialize`
 *   hang-on-request      responds to `initialize`, never responds after
 *   hang-on-shutdown     responds to everything except `shutdown`
 *   exit-after-initialize responds to `initialize`, then exits immediately
 *                          (simulates a crash after a request is already pending)
 *   sends-notification    responds to `initialize`, then pushes a fake
 *                          textDocument/publishDiagnostics notification
 *   reports-temp-directory responds to `initialize` with its TMPDIR for lifecycle cleanup tests
 *   oversized-response    responds after initialize with a deliberately large body
 *   sends-server-request   responds to `initialize`, then issues a sequence of
 *                          server-initiated requests and reports each response
 *                          back via a test/serverRequestResult notification
 *   cancels-own-request    responds to `initialize`, then issues one server-initiated
 *                          request and immediately sends $/cancelRequest for it, then
 *                          reports the eventual reply via test/serverRequestResult
 *   reports-sync-notifications   responds to `initialize` with empty capabilities (spec:
 *                          an omitted textDocumentSync negotiates as TextDocumentSyncKind.None),
 *                          and reports every textDocument/didOpen|didChange|didClose it actually
 *                          receives back via a test/syncNotificationReceived notification -- lets
 *                          a test assert none were sent, not just that nothing crashed.
 *   outgoing-calls-unsupported   responds normally to everything except resolves
 *                          textDocument/prepareCallHierarchy to one fake root, then answers
 *                          callHierarchy/outgoingCalls with a real JSON-RPC "method not found"
 *                          error -- the exact live shape confirmed against clangd 18.1.3 (Ubuntu
 *                          24.04's own packaged version), deterministic here instead of depending
 *                          on which clangd happens to be installed wherever a test runs.
 */
import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcStreamDecoder } from "../../src/code-intelligence/lsp/json-rpc-stream.ts";

const mode = process.env.EVIL_LSP_MODE ?? "normal";
const decoder = new JsonRpcStreamDecoder();

function respond(id: number | string, result: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, result }));
}

function respondError(id: number | string, code: number, message: string): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, error: { code, message } }));
}

function notify(method: string, params: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", method, params }));
}

let nextServerRequestId = 1;
const pendingServerRequests = new Map<string, (message: JsonRpcMessage) => void>();

/** Issues a request FROM this server TO the client, resolving once the client replies. */
function requestFromClient(method: string, params: unknown): Promise<JsonRpcMessage> {
	const id = `srv-${nextServerRequestId++}`;
	return new Promise((resolve) => {
		pendingServerRequests.set(id, resolve);
		process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, method, params }));
	});
}

/**
 * Exercises every server-initiated request Lector's client is expected to
 * handle, one at a time, reporting each real response back via a
 * notification so the test asserts against the client's actual reply
 * rather than assuming it worked.
 */
/** Issues one server-initiated request, cancels it before the client can have answered yet, then reports the client's actual (post-cancellation) reply. */
async function runCancelOwnRequestSequence(): Promise<void> {
	const id = `srv-${nextServerRequestId++}`;
	const responsePromise = new Promise<JsonRpcMessage>((resolve) => {
		pendingServerRequests.set(id, resolve);
	});
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, method: "custom/cancelMe", params: {} }));
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }));
	const response = await responsePromise;
	notify("test/serverRequestResult", { step: "canceled", result: response.result ?? null, error: response.error ?? null });
}

async function runServerInitiatedRequestSequence(): Promise<void> {
	const steps: Array<{ step: string; method: string; params: unknown }> = [
		{
			step: "register",
			method: "client/registerCapability",
			params: { registrations: [{ id: "reg-1", method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: [{ globPattern: "**/*.ts" }] } }] },
		},
		{ step: "unregister", method: "client/unregisterCapability", params: { unregisterations: [{ id: "reg-1" }] } },
		{ step: "configuration", method: "workspace/configuration", params: { items: [{ section: "a" }, { section: "b" }] } },
		{ step: "applyEdit", method: "workspace/applyEdit", params: { edit: { changes: {} } } },
		{ step: "progressCreate", method: "window/workDoneProgress/create", params: { token: "progress-1" } },
		{ step: "workspaceFolders", method: "workspace/workspaceFolders", params: null },
		{ step: "diagnosticRefresh", method: "workspace/diagnostic/refresh", params: null },
		{ step: "unsupported", method: "window/showMessageRequest", params: { type: 1, message: "hi" } },
	];
	for (const { step, method, params } of steps) {
		const response = await requestFromClient(method, params);
		notify("test/serverRequestResult", { step, result: response.result ?? null, error: response.error ?? null });
	}
}

function handle(message: JsonRpcMessage): void {
	if (message.method === undefined) {
		// A response to one of this server's own outbound (server-initiated) requests --
		// never a request needing a reply from us, unlike everything handled below.
		if (typeof message.id === "string") {
			const pending = pendingServerRequests.get(message.id);
			if (pending) {
				pendingServerRequests.delete(message.id);
				pending(message);
			}
		}
		return;
	}
	if (message.method === "exit") {
		process.exit(0);
	}
	if (
		mode === "reports-sync-notifications" &&
		(message.method === "textDocument/didOpen" || message.method === "textDocument/didChange" || message.method === "textDocument/didClose")
	) {
		notify("test/syncNotificationReceived", { method: message.method });
		return;
	}
	if (message.method === "$/cancelRequest") {
		// Reports receipt back to the test -- proves the client actually sent this notification
		// for an outbound request it canceled, not just that its own promise settled locally.
		const params = message.params as { id?: number | string } | undefined;
		if (params?.id !== undefined) notify("test/cancelRequestReceived", { id: params.id });
		return;
	}
	if (message.id === undefined) return; // ignore other notifications

	if (message.method === "initialize") {
		if (mode === "hang-on-initialize") return;
		respond(message.id, { capabilities: {}, ...(mode === "reports-temp-directory" ? { tempDirectory: process.env.TMPDIR } : {}) });
		if (mode === "exit-after-initialize") process.exit(1);
		if (mode === "sends-notification") {
			notify("textDocument/publishDiagnostics", { uri: "file:///fake.ts", diagnostics: [] });
		}
		if (mode === "sends-server-request") {
			void runServerInitiatedRequestSequence();
		}
		if (mode === "cancels-own-request") {
			void runCancelOwnRequestSequence();
		}
		return;
	}

	if (message.method === "shutdown") {
		if (mode === "hang-on-shutdown") return;
		respond(message.id, null);
		return;
	}

	if (mode === "hang-on-request") return;
	if (mode === "oversized-response") {
		respond(message.id, "x".repeat(4_096));
		return;
	}
	if (mode === "document-highlight-classified") {
		if (message.method === "textDocument/documentHighlight") {
			respond(message.id, [
				{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, kind: 1 },
				{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, kind: 2 },
				{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, kind: 3 },
				{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } } }, // no kind at all -- must degrade to "text"
			]);
			return;
		}
	}
	if (mode === "outgoing-calls-unsupported") {
		if (message.method === "textDocument/prepareCallHierarchy") {
			respond(message.id, [
				{
					name: "fakeRoot",
					kind: 12, // SymbolKind.Function
					uri: "file:///fake.cpp",
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				},
			]);
			return;
		}
		if (message.method === "callHierarchy/outgoingCalls") {
			respondError(message.id, -32601, "method not found");
			return;
		}
	}
	respond(message.id, []); // generic empty-array response -- good enough for workspace/symbol-shaped requests
}

process.stdin.on("data", (chunk: Buffer) => {
	for (const message of decoder.push(chunk)) handle(message);
});
process.stdin.resume();
