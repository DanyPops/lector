#!/usr/bin/env bun
import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcStreamDecoder } from "../../src/code-intelligence/lsp/json-rpc-stream.ts";

const decoder = new JsonRpcStreamDecoder();
let initializeRequestId: number | string | undefined;
const promptRequestId = "confirm-rename";

function send(message: JsonRpcMessage): void {
	process.stdout.write(encodeJsonRpcMessage(message));
}

function respond(id: number | string, result: unknown): void {
	send({ jsonrpc: "2.0", id, result });
}

function handle(message: JsonRpcMessage): void {
	if (message.method === "exit") process.exit(0);
	if (message.method === "initialize" && message.id !== undefined) {
		initializeRequestId = message.id;
		send({
			jsonrpc: "2.0",
			id: promptRequestId,
			method: "window/showMessageRequest",
			params: {
				type: 2,
				message: "This name collides with an existing symbol. Rename anyway?",
				actions: [{ title: "Rename anyway" }],
			},
		});
		return;
	}
	if (message.method === undefined && message.id === promptRequestId) {
		if (message.result === null && initializeRequestId !== undefined) {
			respond(initializeRequestId, { capabilities: { textDocumentSync: 1 } });
			initializeRequestId = undefined;
			return;
		}
		if (initializeRequestId !== undefined) {
			send({ jsonrpc: "2.0", id: initializeRequestId, error: { code: -32001, message: "client did not cancel the prompt explicitly" } });
			initializeRequestId = undefined;
		}
		return;
	}
	if (message.method === "shutdown" && message.id !== undefined) {
		respond(message.id, null);
		return;
	}
	if (message.id !== undefined) respond(message.id, []);
}

process.stdin.on("data", (chunk: Buffer) => {
	for (const message of decoder.push(chunk)) handle(message);
});
process.stdin.resume();
