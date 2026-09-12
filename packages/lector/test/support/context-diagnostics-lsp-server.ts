import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcStreamDecoder } from "../../src/code-intelligence/lsp/json-rpc-stream.ts";

const decoder = new JsonRpcStreamDecoder();
const scenario = process.argv[2];
let statusCapability = false;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function notify(method: string, params: unknown): void {
	process.stdout.write(encodeJsonRpcMessage({ jsonrpc: "2.0", method, params }));
}

function handle(message: JsonRpcMessage): void {
	if (message.method === "exit") process.exit(0);
	if (message.method === "initialize") {
		const params = message.params;
		if (record(params) && record(params.capabilities) && record(params.capabilities.experimental))
			statusCapability = params.capabilities.experimental.serverStatusNotification === true;
	}
	if (message.method === "textDocument/didOpen" && record(message.params) && record(message.params.textDocument)) {
		const document = message.params.textDocument;
		if (scenario === "python-missing") notify("window/logMessage", { type: 1, message: "Python interpreter could not be found" });
		if (scenario !== "python-missing" && scenario !== "python-healthy")
			notify("experimental/serverStatus", {
				health: scenario === "rust-missing" ? "warning" : "ok",
				quiescent: true,
				...(scenario === "rust-missing" ? { message: "Failed to find sysroot" } : {}),
			});
		notify("textDocument/publishDiagnostics", {
			uri: document.uri,
			version: scenario === "stale" ? 0 : document.version,
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					severity: 1,
					message: "native type mismatch",
					code: statusCapability ? "native-code" : "missing-status-capability",
					source: "fixture",
				},
			],
		});
	}
	if (message.id === undefined) return;
	process.stdout.write(
		encodeJsonRpcMessage({
			jsonrpc: "2.0",
			id: message.id,
			result: message.method === "initialize" ? { capabilities: { textDocumentSync: 1 }, serverInfo: { name: "fixture", version: "1.2.3" } } : null,
		}),
	);
}

process.stdin.on("data", (chunk: Buffer) => {
	for (const message of decoder.push(chunk)) handle(message);
});
process.stdin.resume();
