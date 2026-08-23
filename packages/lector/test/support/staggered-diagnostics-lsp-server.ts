#!/usr/bin/env bun
/**
 * A minimal mock LSP server reproducing typescript-language-server's real,
 * documented behavior: diagnostics for one file arrive from tsserver in
 * separate kinds (Syntax, Semantic, Suggestion) at different times, each
 * publish debounced independently, so a single edit can legitimately
 * produce two or more separate textDocument/publishDiagnostics
 * notifications for the same uri -- an early, incomplete one (e.g.
 * syntax-clean) followed later by a fuller one (e.g. the real semantic
 * type error). Push-only: no diagnosticProvider declared, matching
 * TypeScript's own negotiated capabilities.
 */
import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcStreamDecoder } from "../../src/code-intelligence/lsp/json-rpc-stream.ts";

const decoder = new JsonRpcStreamDecoder();

function respond(id: number | string, result: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, result }));
}

function notify(method: string, params: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", method, params }));
}

function extractUri(params: unknown): string | undefined {
	if (typeof params !== "object" || params === null) return undefined;
	const textDocument = (params as Record<string, unknown>).textDocument;
	if (typeof textDocument !== "object" || textDocument === null) return undefined;
	const uri = (textDocument as Record<string, unknown>).uri;
	return typeof uri === "string" ? uri : undefined;
}

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

// Every didChange (edit) publishes an early, empty ("syntax-clean") notification quickly, then a
// later, real diagnostic ("semantic") notification for the same uri -- the exact two-stage shape
// confirmed live in typescript-language-server's own DiagnosticsManager/FileDiagnostics classes.
const EARLY_DELAY_MS = 10;
const LATE_DELAY_MS = 80;

function publishEditDiagnostics(uri: string): void {
	setTimeout(() => notify("textDocument/publishDiagnostics", { uri, diagnostics: [] }), EARLY_DELAY_MS);
	setTimeout(
		() =>
			notify("textDocument/publishDiagnostics", {
				uri,
				diagnostics: [{ range, severity: 1, message: "simulated semantic diagnostic: not assignable", source: "mock", code: "TS2322" }],
			}),
		LATE_DELAY_MS,
	);
}

function handle(message: JsonRpcMessage): void {
	if (message.method === "exit") process.exit(0);

	if (message.method === "textDocument/didOpen") {
		const uri = extractUri(message.params);
		if (uri) setTimeout(() => notify("textDocument/publishDiagnostics", { uri, diagnostics: [] }), EARLY_DELAY_MS);
		return; // notification -- no reply
	}

	if (message.method === "textDocument/didChange") {
		const uri = extractUri(message.params);
		if (uri) publishEditDiagnostics(uri);
		return; // notification -- no reply
	}

	if (message.id === undefined) return; // ignore other notifications (initialized, ...)

	if (message.method === "initialize") {
		respond(message.id, { capabilities: { textDocumentSync: 1 } });
		return;
	}

	if (message.method === "shutdown") {
		respond(message.id, null);
		return;
	}

	respond(message.id, []); // generic fallback for anything else (workspace/symbol, etc.)
}

process.stdin.on("data", (chunk: Buffer) => {
	for (const message of decoder.push(chunk)) handle(message);
});
process.stdin.resume();
