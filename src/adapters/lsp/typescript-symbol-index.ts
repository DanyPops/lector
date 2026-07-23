import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorkspaceSymbol } from "../../domain/workspace-symbol.ts";
import type { SymbolIndexPort } from "../../ports/symbol-index-port.ts";
import { LanguageServerProcess } from "./language-server-process.ts";

const LSP_SYMBOL_KIND_NAMES: Readonly<Record<number, string>> = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enum-member",
	23: "struct",
	24: "event",
	25: "operator",
	26: "type-parameter",
};

interface LspSymbolInformation {
	name: string;
	kind: number;
	location: { uri: string; range: { start: { line: number; character: number } } };
	containerName?: string;
}

function resolveTypescriptLanguageServerBin(): string {
	return fileURLToPath(import.meta.resolve("typescript-language-server/lib/cli.mjs"));
}

/**
 * SymbolIndexPort backed by a live typescript-language-server process,
 * queried via `workspace/symbol`. Lazily spawned on first use and kept warm
 * for the adapter's lifetime; the caller (the service) owns when to stop()
 * it via close().
 *
 * `seedFile` (workspace-relative) is a real, documented tsserver quirk, not
 * a Lector workaround: `workspace/symbol` (tsserver's `navto`) only searches
 * projects tsserver has already loaded, and a project is loaded lazily only
 * once one of its files is opened via `textDocument/didOpen` -- querying
 * before that fails with "No Project." (confirmed against a real server
 * while building this). Any file covered by the target tsconfig.json is
 * enough to pull the whole project into scope.
 */
export class TypescriptSymbolIndex implements SymbolIndexPort {
	private readonly cwd: string;
	private readonly seedFile: string;
	private process: LanguageServerProcess | undefined;
	private initializing: Promise<LanguageServerProcess> | undefined;

	constructor(cwd: string, seedFile: string) {
		this.cwd = cwd;
		this.seedFile = seedFile;
	}

	private async ensureInitialized(): Promise<LanguageServerProcess> {
		if (this.process) return this.process;
		if (!this.initializing) {
			this.initializing = (async () => {
				const proc = LanguageServerProcess.spawnProcess({
					command: "bun",
					args: [resolveTypescriptLanguageServerBin(), "--stdio"],
					cwd: this.cwd,
				});
				await proc.request("initialize", {
					processId: process.pid,
					rootUri: pathToFileURL(this.cwd).href,
					capabilities: {},
					initializationOptions: {},
				});
				proc.notify("initialized", {});

				const seedPath = join(this.cwd, this.seedFile);
				proc.notify("textDocument/didOpen", {
					textDocument: {
						uri: pathToFileURL(seedPath).href,
						languageId: "typescript",
						version: 1,
						text: readFileSync(seedPath, "utf-8"),
					},
				});
				// tsserver loads the project asynchronously after didOpen; there is no
				// notification for "project loaded", so a short, deliberate wait is the
				// documented approach (matches Alef's own lsp-client.ts, same gotcha).
				await new Promise((resolve) => setTimeout(resolve, 300));

				this.process = proc;
				return proc;
			})();
		}
		return this.initializing;
	}

	async findSymbols(query: string): Promise<WorkspaceSymbol[]> {
		const proc = await this.ensureInitialized();
		const results = (await proc.request<LspSymbolInformation[] | null>("workspace/symbol", { query })) ?? [];
		return results.map((symbol) => ({
			name: symbol.name,
			kind: LSP_SYMBOL_KIND_NAMES[symbol.kind] ?? "unknown",
			location: {
				path: fileURLToPath(symbol.location.uri),
				line: symbol.location.range.start.line + 1,
				character: symbol.location.range.start.character + 1,
			},
			containerName: symbol.containerName,
		}));
	}

	async close(): Promise<void> {
		await this.process?.stop();
		this.process = undefined;
		this.initializing = undefined;
	}
}
