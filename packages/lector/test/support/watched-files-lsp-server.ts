#!/usr/bin/env bun
/**
 * A minimal mock LSP server that dynamically registers interest in
 * workspace/didChangeWatchedFiles for a fixed glob pattern right after
 * initialize, then records every such notification it receives to a
 * side-channel file (`.received-watched-files.json` in its own cwd, which
 * is the spawning LspSymbolIndex's workspace root) -- so a real
 * LspSymbolIndex spawned against it proves the "notify every matching warm
 * server" half of local file-watch support end to end, observable from the
 * test without needing any test-only introspection API on LspSymbolIndex
 * itself (stdout is already fully consumed by JSON-RPC framing).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcStreamDecoder } from "../../src/adapters/lsp/json-rpc-stream.ts";

const decoder = new JsonRpcStreamDecoder();
const RECEIVED_LOG_PATH = join(process.cwd(), ".received-watched-files.json");

function respond(id: number | string, result: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, result }));
}

function request(id: string, method: string, params: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, method, params }));
}

function handle(message: JsonRpcMessage): void {
	if (message.method === "exit") process.exit(0);

	if (message.method === "workspace/didChangeWatchedFiles") {
		appendFileSync(RECEIVED_LOG_PATH, `${JSON.stringify(message.params)}\n`);
		return; // notification -- no reply
	}

	if (message.id === undefined) return; // ignore other notifications (didOpen, didChange, initialized, ...)

	if (message.method === "initialize") {
		respond(message.id, { capabilities: {} });
		// Registers interest in *.ts files only, so the test can prove a non-matching path is
		// correctly never forwarded.
		request("watch-reg-1", "client/registerCapability", {
			registrations: [{ id: "watch-reg-1", method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: [{ globPattern: "**/*.ts" }] } }],
		});
		return;
	}

	if (message.method === "shutdown") {
		respond(message.id, null);
		return;
	}

	respond(message.id, []); // generic fallback
}

process.stdin.on("data", (chunk: Buffer) => {
	for (const message of decoder.push(chunk)) handle(message);
});
process.stdin.resume();
