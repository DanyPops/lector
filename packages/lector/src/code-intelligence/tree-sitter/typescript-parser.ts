import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";

/**
 * Shared web-tree-sitter bootstrap for every tree-sitter-backed TypeScript/JavaScript adapter
 * (symbol extraction, import-specifier scanning). One process-wide `Parser.init()` and one
 * cache of already-loaded grammars, keyed by wasm path -- loading the same grammar twice per
 * process is pure waste, and every caller needs the exact same extension-to-grammar mapping.
 */

let parserInitialization: Promise<void> | undefined;
function ensureParserInitialized(): Promise<void> {
	parserInitialization ??= Parser.init();
	return parserInitialization;
}

export function wasmPathForExtension(extension: string): string | undefined {
	const specifier =
		extension === ".ts"
			? "tree-sitter-wasms/out/tree-sitter-typescript.wasm"
			: extension === ".tsx"
				? "tree-sitter-wasms/out/tree-sitter-tsx.wasm"
				: extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs"
					? "tree-sitter-wasms/out/tree-sitter-javascript.wasm"
					: undefined;
	return specifier ? fileURLToPath(import.meta.resolve(specifier)) : undefined;
}

const parsersByWasmPath = new Map<string, Parser>();

/** A ready-to-use, cached parser for an already-resolved wasm grammar path. */
export async function parserForWasmPath(wasmPath: string): Promise<Parser> {
	const cached = parsersByWasmPath.get(wasmPath);
	if (cached) return cached;
	await ensureParserInitialized();
	const language = await Parser.Language.load(wasmPath);
	const parser = new Parser();
	parser.setLanguage(language);
	parsersByWasmPath.set(wasmPath, parser);
	return parser;
}

/** A ready-to-use parser for `extension`, or undefined when no grammar is registered for it. Never throws for an unsupported extension. */
export async function parserForExtension(extension: string): Promise<Parser | undefined> {
	const wasmPath = wasmPathForExtension(extension);
	return wasmPath ? parserForWasmPath(wasmPath) : undefined;
}
