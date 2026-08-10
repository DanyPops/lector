#!/usr/bin/env bun
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcStreamDecoder } from "../../src/code-intelligence/lsp/json-rpc-stream.ts";

const decoder = new JsonRpcStreamDecoder();
const progressToken = "initial-index";
let indexing = false;

function send(message: JsonRpcMessage): void {
	process.stdout.write(encodeJsonRpcMessage(message));
}

function respond(id: number | string, result: unknown): void {
	send({ jsonrpc: "2.0", id, result });
}

function notify(method: string, params: unknown): void {
	send({ jsonrpc: "2.0", method, params });
}

function startIndexing(): void {
	indexing = true;
	notify("$/progress", { token: progressToken, value: { kind: "begin", title: "indexing workspace" } });
	if (!process.argv.includes("--never-finish")) {
		setTimeout(() => {
			indexing = false;
			notify("$/progress", { token: progressToken, value: { kind: "end" } });
		}, 200);
	}
}

function handle(message: JsonRpcMessage): void {
	if (message.method === "exit") process.exit(0);
	if (message.method === "textDocument/didOpen") {
		startIndexing();
		return;
	}
	if (message.id === undefined) return;
	if (message.method === "initialize") {
		respond(message.id, { capabilities: { workspaceSymbolProvider: true, textDocumentSync: 1 } });
		return;
	}
	if (message.method === "workspace/symbol") {
		respond(
			message.id,
			indexing
				? []
				: [
						{
							name: "readySymbol",
							kind: 12,
							location: {
								uri: pathToFileURL(join(process.cwd(), "seed.ts")).href,
								range: { start: { line: 0, character: 16 }, end: { line: 0, character: 27 } },
							},
						},
					],
		);
		return;
	}
	if (message.method === "textDocument/references") {
		respond(
			message.id,
			indexing
				? []
				: [
						{
							uri: pathToFileURL(join(process.cwd(), "seed.ts")).href,
							range: { start: { line: 0, character: 16 }, end: { line: 0, character: 27 } },
						},
					],
		);
		return;
	}
	if (message.method === "textDocument/definition") {
		respond(
			message.id,
			indexing
				? null
				: {
						uri: pathToFileURL(join(process.cwd(), "seed.ts")).href,
						range: { start: { line: 0, character: 16 }, end: { line: 0, character: 27 } },
					},
		);
		return;
	}
	if (message.method === "textDocument/prepareCallHierarchy") {
		// Only under --restart-indexing-after-call-hierarchy: simulates a second, independent
		// background episode starting right as the call-hierarchy root resolves -- proves whether
		// a caller's own second request (callHierarchy/outgoingCalls/incomingCalls) waits for THIS
		// new episode too, not just the one already gating prepareCallHierarchy itself. Started
		// (and its "begin" notification written) BEFORE this response, so a client reading this
		// same ordered stream is guaranteed to have already seen "begin" by the time it processes
		// the response and immediately checks readiness for its own next request -- no notification-
		// vs-response race to land on either side of that check.
		const wasIndexing = indexing;
		if (!wasIndexing && process.argv.includes("--restart-indexing-after-call-hierarchy")) startIndexing();
		respond(
			message.id,
			wasIndexing
				? null
				: [
						{
							name: "readySymbol",
							kind: 12,
							uri: pathToFileURL(join(process.cwd(), "seed.ts")).href,
							range: { start: { line: 0, character: 16 }, end: { line: 0, character: 27 } },
							selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 27 } },
						},
					],
		);
		return;
	}
	if (message.method === "callHierarchy/outgoingCalls") {
		respond(
			message.id,
			indexing
				? null
				: [
						{
							to: {
								name: "realCallee",
								kind: 12,
								uri: pathToFileURL(join(process.cwd(), "seed.ts")).href,
								range: { start: { line: 0, character: 16 }, end: { line: 0, character: 27 } },
								selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 27 } },
							},
							fromRanges: [{ start: { line: 0, character: 16 }, end: { line: 0, character: 27 } }],
						},
					],
		);
		return;
	}
	if (message.method === "callHierarchy/incomingCalls") {
		respond(
			message.id,
			indexing
				? null
				: [
						{
							from: {
								name: "realCaller",
								kind: 12,
								uri: pathToFileURL(join(process.cwd(), "seed.ts")).href,
								range: { start: { line: 0, character: 16 }, end: { line: 0, character: 27 } },
								selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 27 } },
							},
							fromRanges: [{ start: { line: 0, character: 16 }, end: { line: 0, character: 27 } }],
						},
					],
		);
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
