#!/usr/bin/env bun
/**
 * A minimal mock LSP server that declares pull-model diagnostic support
 * (capabilities.diagnosticProvider) and answers textDocument/diagnostic
 * directly, while also pushing one push-model diagnostic via
 * publishDiagnostics shortly after a file is opened -- so a real
 * LspSymbolIndex spawned against it proves the pull request path and the
 * push/pull merge/dedup both work end to end, something TypeScript
 * (Lector's push-only reference server) cannot exercise.
 */
import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcStreamDecoder } from "../../src/adapters/lsp/json-rpc-stream.ts";

const decoder = new JsonRpcStreamDecoder();

function respond(id: number | string, result: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, result }));
}

function notify(method: string, params: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", method, params }));
}

function extractOpenedUri(params: unknown): string | undefined {
	if (typeof params !== "object" || params === null) return undefined;
	const textDocument = (params as Record<string, unknown>).textDocument;
	if (typeof textDocument !== "object" || textDocument === null) return undefined;
	const uri = (textDocument as Record<string, unknown>).uri;
	return typeof uri === "string" ? uri : undefined;
}

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function handle(message: JsonRpcMessage): void {
	if (message.method === "exit") process.exit(0);

	if (message.method === "textDocument/didOpen") {
		const uri = extractOpenedUri(message.params);
		if (uri) {
			// Fires after the file is actually opened, like a real server's own analysis timing.
			setTimeout(() => {
				notify("textDocument/publishDiagnostics", {
					uri,
					diagnostics: [
						{ range, severity: 2, message: "pushed: unused variable", source: "mock", code: "TS0001" },
						{ range, severity: 1, message: "same issue, both channels", source: "mock", code: "TS9999" },
					],
				});
			}, 50);
		}
		return; // notification -- no reply
	}

	if (message.id === undefined) return; // ignore other notifications (didChange, initialized, ...)

	if (message.method === "initialize") {
		respond(message.id, { capabilities: { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } });
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
			items: [
				{ range, severity: 1, message: "pulled: real type error", source: "mock", code: "TS0002" },
				{ range, severity: 1, message: "same issue, both channels", source: "mock", code: "TS9999" },
			],
		});
		return;
	}

	respond(message.id, []); // generic fallback for anything else (workspace/symbol, etc.)
}

process.stdin.on("data", (chunk: Buffer) => {
	for (const message of decoder.push(chunk)) handle(message);
});
process.stdin.resume();
