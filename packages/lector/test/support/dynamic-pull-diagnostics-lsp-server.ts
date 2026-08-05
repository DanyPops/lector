#!/usr/bin/env bun
/**
 * A mock LSP server that never declares diagnosticProvider statically in its initialize
 * response -- it registers pull-model diagnostic support dynamically instead, via
 * client/registerCapability sent shortly after initialized, exactly the pattern real servers
 * like Roslyn (C#) and the Kotlin language server use. Proves LspSymbolIndex's diagnostics()
 * consults DynamicCapabilityRegistry, not just the static initialize response, before falling
 * back to the push-wait path.
 */
import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcStreamDecoder } from "../../src/code-intelligence/lsp/json-rpc-stream.ts";

const decoder = new JsonRpcStreamDecoder();
let nextId = 1;

function respond(id: number | string, result: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, result }));
}

function request(method: string, params: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id: nextId++, method, params }));
}

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function handle(message: JsonRpcMessage): void {
	if (message.method === "exit") process.exit(0);

	if (message.method === "initialized") {
		// Only ever registered dynamically -- capabilities.diagnosticProvider is deliberately
		// absent from this server's initialize response below, matching Roslyn/Kotlin's own
		// real-world behavior of registering pull-diagnostic support post-initialize.
		request("client/registerCapability", {
			registrations: [
				{
					id: "dynamic-diagnostics-1",
					method: "textDocument/diagnostic",
					registerOptions: { identifier: "mock-dynamic", interFileDependencies: false, workspaceDiagnostics: false },
				},
			],
		});
		return; // notification -- no reply
	}

	if (message.id === undefined) return; // ignore other notifications (didOpen, didChange, ...)

	if (message.method === "initialize") {
		respond(message.id, { capabilities: { textDocumentSync: 1 } });
		return;
	}

	if (message.method === "shutdown") {
		respond(message.id, null);
		return;
	}

	if (message.method === "textDocument/diagnostic") {
		respond(message.id, {
			kind: "full",
			resultId: "1",
			items: [{ range, severity: 1, message: "pulled via dynamic registration", source: "mock", code: "DYN0001" }],
		});
		return;
	}

	respond(message.id, []); // generic fallback for anything else (workspace/symbol, ...)
}

process.stdin.on("data", (chunk: Buffer) => {
	for (const message of decoder.push(chunk)) handle(message);
});
process.stdin.resume();
