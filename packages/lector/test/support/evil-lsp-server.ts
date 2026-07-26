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
 *   oversized-response    responds after initialize with a deliberately large body
 */
import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcStreamDecoder } from "../../src/adapters/lsp/json-rpc-stream.ts";

const mode = process.env.EVIL_LSP_MODE ?? "normal";
const decoder = new JsonRpcStreamDecoder();

function respond(id: number | string, result: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, result }));
}

function notify(method: string, params: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", method, params }));
}

function handle(message: JsonRpcMessage): void {
	if (message.method === "exit") {
		process.exit(0);
	}
	if (message.id === undefined) return; // ignore other notifications

	if (message.method === "initialize") {
		if (mode === "hang-on-initialize") return;
		respond(message.id, { capabilities: {} });
		if (mode === "exit-after-initialize") process.exit(1);
		if (mode === "sends-notification") {
			notify("textDocument/publishDiagnostics", { uri: "file:///fake.ts", diagnostics: [] });
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
	respond(message.id, []); // generic empty-array response -- good enough for workspace/symbol-shaped requests
}

process.stdin.on("data", (chunk: Buffer) => {
	for (const message of decoder.push(chunk)) handle(message);
});
process.stdin.resume();
