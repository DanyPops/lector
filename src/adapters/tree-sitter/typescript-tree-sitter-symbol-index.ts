import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";
import type { WorkspaceSymbol } from "../../domain/workspace-symbol.ts";
import type { SymbolIndexPort } from "../../ports/symbol-index-port.ts";

const SKIP_DIRECTORY_NAMES = new Set(["node_modules", ".git", "dist", "build", "out", "coverage"]);
const MAX_FILES_SCANNED = 5_000;

interface DeclarationKind {
	readonly nodeType: string;
	readonly kind: string;
}

/** Top-level and class-member declaration shapes in tree-sitter's TypeScript/JavaScript grammars. */
const DECLARATION_KINDS: readonly DeclarationKind[] = [
	{ nodeType: "function_declaration", kind: "function" },
	{ nodeType: "class_declaration", kind: "class" },
	{ nodeType: "interface_declaration", kind: "interface" },
	{ nodeType: "type_alias_declaration", kind: "type-alias" },
	{ nodeType: "enum_declaration", kind: "enum" },
	{ nodeType: "method_definition", kind: "method" },
];

let parserInitialization: Promise<void> | undefined;
function ensureParserInitialized(): Promise<void> {
	if (!parserInitialization) parserInitialization = Parser.init();
	return parserInitialization;
}

function wasmPathFor(extension: string): string | undefined {
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

/** Bounded (entry-count-limited, skips node_modules/.git/build output) recursive source-file scan. */
function findSourceFiles(rootPath: string): string[] {
	const files: string[] = [];
	let scanned = 0;

	const visit = (relativeDir: string): void => {
		if (scanned >= MAX_FILES_SCANNED) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(join(rootPath, relativeDir), { withFileTypes: true, encoding: "utf-8" });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (scanned >= MAX_FILES_SCANNED) return;
			const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
			if (entry.isDirectory()) {
				if (SKIP_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
				visit(relativePath);
			} else if (entry.isFile() && wasmPathFor(extname(entry.name))) {
				scanned++;
				files.push(relativePath);
			}
		}
	};

	visit("");
	return files;
}

function extractDeclarations(root: Parser.SyntaxNode, relativePath: string): WorkspaceSymbol[] {
	const results: WorkspaceSymbol[] = [];
	for (const spec of DECLARATION_KINDS) {
		for (const node of root.descendantsOfType(spec.nodeType)) {
			const nameNode = node.childForFieldName("name");
			if (!nameNode) continue;
			results.push({
				name: nameNode.text,
				kind: spec.kind,
				location: { path: relativePath, line: node.startPosition.row + 1, character: node.startPosition.column + 1 },
			});
		}
	}
	return results;
}

/**
 * SymbolIndexPort backed by tree-sitter (via web-tree-sitter's WASM runtime, not the
 * native `tree-sitter` binding -- that requires node-gyp/a native toolchain to compile
 * from source, which this environment does not have; WASM avoids that fragility
 * entirely, the same trade-off CodeGraph documents for its own native-vs-WASM engines).
 *
 * No subprocess, no warm server, no "No Project." gotcha: every call parses whatever
 * source files currently exist under the workspace root, so results are always current
 * with no invalidation to reason about -- at the cost of re-scanning and re-parsing the
 * whole tree on every query (doc 38db976d's persisted/cached index question is explicitly
 * not decided yet; this is the uncached, correctness-first version).
 *
 * `tree-sitter-wasms` bundles pre-built grammars from tree-sitter-cli 0.20.x; `web-tree-sitter`
 * is pinned to the matching 0.20.8 release rather than its current 0.26.x line, which cannot
 * load grammars built against that older WASM ABI (confirmed directly: 0.26.11 threw a
 * dylink-metadata load error against these exact .wasm files).
 */
export class TreeSitterSymbolIndex implements SymbolIndexPort {
	private readonly rootPath: string;
	private readonly parsersByWasmPath = new Map<string, Parser>();

	constructor(rootPath: string) {
		this.rootPath = rootPath;
	}

	private async parserFor(wasmPath: string): Promise<Parser> {
		const cached = this.parsersByWasmPath.get(wasmPath);
		if (cached) return cached;
		await ensureParserInitialized();
		const language = await Parser.Language.load(wasmPath);
		const parser = new Parser();
		parser.setLanguage(language);
		this.parsersByWasmPath.set(wasmPath, parser);
		return parser;
	}

	async findSymbols(query: string): Promise<WorkspaceSymbol[]> {
		const lowerQuery = query.toLowerCase();
		const results: WorkspaceSymbol[] = [];

		for (const relativePath of findSourceFiles(this.rootPath)) {
			const wasmPath = wasmPathFor(extname(relativePath));
			if (!wasmPath) continue;

			let content: string;
			try {
				content = readFileSync(join(this.rootPath, relativePath), "utf-8");
			} catch {
				continue;
			}

			const parser = await this.parserFor(wasmPath);
			const tree = parser.parse(content);
			if (!tree) continue;

			for (const symbol of extractDeclarations(tree.rootNode, relativePath)) {
				if (symbol.name.toLowerCase().includes(lowerQuery)) results.push(symbol);
			}
		}

		return results;
	}

	async close(): Promise<void> {
		// In-process, synchronous parsing -- no subprocess or handle to release.
	}
}
