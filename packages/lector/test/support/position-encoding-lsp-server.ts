#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcStreamDecoder } from "../../src/code-intelligence/lsp/json-rpc-stream.ts";

const decoder = new JsonRpcStreamDecoder();
const requestedEncoding = process.argv.includes("--utf8") ? "utf-8" : "utf-16";

function respond(id: number | string, result: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, result }));
}

function handle(message: JsonRpcMessage): void {
	if (message.method === "exit") process.exit(0);
	if (message.id === undefined) return;
	if (message.method === "initialize") {
		writeFileSync(join(process.cwd(), ".initialize-params.json"), JSON.stringify(message.params));
		respond(message.id, { capabilities: { positionEncoding: requestedEncoding, textDocumentSync: 1 } });
		return;
	}
	if (message.method === "shutdown") {
		respond(message.id, null);
		return;
	}
	respond(message.id, []);
}

process.stdin.on("data", (chunk: Buffer) => {
	for (const message of decoder.push(chunk)) handle(message);
});
process.stdin.resume();
