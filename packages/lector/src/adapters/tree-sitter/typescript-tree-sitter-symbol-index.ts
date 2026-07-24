import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";
import { contentHashOf } from "../../domain/content-hash.ts";
import type { WorkspaceSymbol } from "../../domain/workspace-symbol.ts";
import type { ContentCachePort, ContentSymbol } from "../../ports/content-cache-port.ts";
import type { SymbolIndexPort } from "../../ports/symbol-index-port.ts";
import { findSourceFiles } from "../find-source-files.ts";
import { InMemoryContentCache } from "../in-memory-content-cache.ts";

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

/** Content-derived only -- no path, so the extraction result is valid caching material regardless of which file currently holds this content. */
function extractContentSymbols(root: Parser.SyntaxNode): ContentSymbol[] {
	const results: ContentSymbol[] = [];
	for (const spec of DECLARATION_KINDS) {
		for (const node of root.descendantsOfType(spec.nodeType)) {
			const nameNode = node.childForFieldName("name");
			if (!nameNode) continue;
			results.push({ name: nameNode.text, kind: spec.kind, line: node.startPosition.row + 1, character: node.startPosition.column + 1 });
		}
	}
	return results;
}

function toWorkspaceSymbols(symbols: readonly ContentSymbol[], relativePath: string): WorkspaceSymbol[] {
	return symbols.map((symbol) => ({
		name: symbol.name,
		kind: symbol.kind,
		location: { path: relativePath, line: symbol.line, character: symbol.character },
		...(symbol.containerName !== undefined ? { containerName: symbol.containerName } : {}),
	}));
}

/**
 * SymbolIndexPort backed by tree-sitter, via web-tree-sitter's WASM runtime
 * (the native `tree-sitter` binding needs node-gyp, unavailable here).
 *
 * No subprocess or warm server: every call parses whatever files currently
 * exist under the workspace root, so results are always current, at the
 * cost of re-parsing on every query -- mitigated by the ContentHash-keyed
 * cache below.
 *
 * `web-tree-sitter` is pinned to 0.20.8, matching the WASM ABI
 * `tree-sitter-wasms`' prebuilt grammars were compiled against; 0.26.x
 * fails to load them.
 *
 * Per-file results are cached, keyed by ContentHash, via an injected
 * ContentCachePort (default in-memory; pass SqliteContentCache for
 * durability). A cache hit skips parsing entirely, and also warms the
 * cache's rawContent lens for that hash, since the content was already
 * read to compute it.
 */
export class TreeSitterSymbolIndex implements SymbolIndexPort {
	private readonly rootPath: string;
	private readonly contentCache: ContentCachePort;
	private readonly parsersByWasmPath = new Map<string, Parser>();

	constructor(rootPath: string, contentCache: ContentCachePort = new InMemoryContentCache()) {
		this.rootPath = rootPath;
		this.contentCache = contentCache;
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

	private async contentSymbolsFor(relativePath: string, wasmPath: string, content: string): Promise<ContentSymbol[]> {
		const hash = contentHashOf(content);

		// Reading the file already required reading its content -- warm the fs lens for this
		// hash regardless of whether the symbols lens below is a hit or a miss. Awaited, not
		// fire-and-forget: a caller reading this hash's rawContent right after findSymbols
		// resolves must see it, not race an in-flight write.
		await this.contentCache.putRawContent(hash, content);

		const cached = await this.contentCache.get(hash);
		if (cached?.symbols) return [...cached.symbols];

		const parser = await this.parserFor(wasmPath);
		const tree = parser.parse(content);
		const symbols = tree ? extractContentSymbols(tree.rootNode) : [];
		await this.contentCache.putSymbols(hash, symbols);
		return symbols;
	}

	async findSymbols(query: string): Promise<WorkspaceSymbol[]> {
		const lowerQuery = query.toLowerCase();
		const results: WorkspaceSymbol[] = [];

		for (const relativePath of findSourceFiles(this.rootPath, (extension) => wasmPathFor(extension) !== undefined, MAX_FILES_SCANNED)) {
			const wasmPath = wasmPathFor(extname(relativePath));
			if (!wasmPath) continue;

			let content: string;
			try {
				content = readFileSync(join(this.rootPath, relativePath), "utf-8");
			} catch {
				continue;
			}

			const contentSymbols = await this.contentSymbolsFor(relativePath, wasmPath, content);
			for (const symbol of toWorkspaceSymbols(contentSymbols, relativePath)) {
				if (symbol.name.toLowerCase().includes(lowerQuery)) results.push(symbol);
			}
		}

		return results;
	}

	async close(): Promise<void> {
		// In-process, synchronous parsing -- no subprocess or handle to release.
	}
}
