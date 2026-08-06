#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcStreamDecoder } from "../../src/code-intelligence/lsp/json-rpc-stream.ts";

const decoder = new JsonRpcStreamDecoder();
const logPath = join(process.cwd(), ".file-operations.jsonl");
const fileOperationMethods = new Set(["workspace/willCreateFiles", "workspace/didCreateFiles", "workspace/willDeleteFiles", "workspace/didDeleteFiles"]);

function respond(id: number | string, result: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, result }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function advertisedFileOperations(params: unknown): boolean {
	if (!isRecord(params) || !isRecord(params.capabilities)) return false;
	const { workspace } = params.capabilities;
	if (!isRecord(workspace)) return false;
	const { fileOperations } = workspace;
	if (!isRecord(fileOperations)) return false;
	return ["willCreate", "didCreate", "willDelete", "didDelete"].every((key) => fileOperations[key] === true);
}

function handle(message: JsonRpcMessage): void {
	if (message.method === "exit") process.exit(0);
	if (message.method && fileOperationMethods.has(message.method)) {
		appendFileSync(logPath, `${JSON.stringify({ method: message.method, params: message.params })}\n`);
		if (message.id !== undefined) respond(message.id, null);
		return;
	}
	if (message.method === "initialize" && message.id !== undefined) {
		const fileOperations =
			advertisedFileOperations(message.params) && !process.argv.includes("--without-file-operations")
				? { willCreate: {}, didCreate: {}, willDelete: {}, didDelete: {} }
				: undefined;
		respond(message.id, {
			capabilities: {
				textDocumentSync: 1,
				workspace: { fileOperations },
			},
		});
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
