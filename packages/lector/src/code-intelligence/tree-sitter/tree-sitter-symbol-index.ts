import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type Parser from "web-tree-sitter";
import type { IntelligenceProvenance, SymbolSearchBounds } from "../../code-intelligence/intelligence-provenance.ts";
import type { SymbolIndexPort } from "../../code-intelligence/symbol-index-port.ts";
import { InMemoryContentCache } from "../../content-cache/in-memory-content-cache.ts";
import type { ContentCachePort, ContentSymbol } from "../../content-cache/port.ts";
import { contentHashOf } from "../../content-identity/content-hash.ts";
import { findSourceFiles } from "../../text-search/find-source-files.ts";
import type { SymbolSearchResult, WorkspaceSymbol } from "../../workspace/workspace-symbol.ts";
import { parserForWasmPath, wasmPathForExtension } from "./typescript-parser.ts";

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 1_000;

export interface TreeSitterSymbolIndexOptions {
	readonly maxFiles?: number;
	readonly maxFileBytes?: number;
	readonly maxTotalBytes?: number;
	readonly maxResults?: number;
	/** Scopes this index to one language's own file extensions and declares its own provenance/declaration-kind table -- used when wrapping a single failed language server (e.g. a Python-only structural fallback), as opposed to the unscoped default (every extension with a registered grammar, TypeScript's own long-standing behavior). */
	readonly language?: { readonly languageId: string; readonly backend: string; readonly extensions: readonly string[] };
}

function positiveLimit(value: number | undefined, fallback: number, field: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${field} must be a positive safe integer`);
	return result;
}

interface DeclarationKind {
	readonly nodeType: string;
	readonly kind: string;
}

/** Top-level and class-member declaration shapes in tree-sitter's TypeScript/JavaScript grammars. */
export const DECLARATION_KINDS: readonly DeclarationKind[] = [
	{ nodeType: "function_declaration", kind: "function" },
	{ nodeType: "class_declaration", kind: "class" },
	{ nodeType: "interface_declaration", kind: "interface" },
	{ nodeType: "type_alias_declaration", kind: "type-alias" },
	{ nodeType: "enum_declaration", kind: "enum" },
	{ nodeType: "method_definition", kind: "method" },
];

/** Top-level and class-member declaration shapes in tree-sitter's Python grammar -- Python has no separate interface/enum/type-alias declaration syntax the way TypeScript does, so only function/class definitions are extracted. */
export const PYTHON_DECLARATION_KINDS: readonly DeclarationKind[] = [
	{ nodeType: "function_definition", kind: "function" },
	{ nodeType: "class_definition", kind: "class" },
];

/** Selects the right declaration-kind table for a given source file extension -- extends to a new language by adding one entry here, not by branching extraction logic. Exported for reuse by every other tree-sitter-backed adapter that extracts named declarations (declaration-text.ts's own cross-version symbol comparison), not just this file's own findSymbols. */
export function declarationKindsForExtension(extension: string): readonly DeclarationKind[] {
	return extension === ".py" ? PYTHON_DECLARATION_KINDS : DECLARATION_KINDS;
}

/** Content-derived only -- no path, so the extraction result is valid caching material regardless of which file currently holds this content. */
function extractContentSymbols(root: Parser.SyntaxNode, declarationKinds: readonly DeclarationKind[]): ContentSymbol[] {
	const results: ContentSymbol[] = [];
	for (const spec of declarationKinds) {
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
	readonly provenance: IntelligenceProvenance;
	private readonly rootPath: string;
	private readonly contentCache: ContentCachePort;
	private readonly maxFiles: number;
	private readonly maxFileBytes: number;
	private readonly maxTotalBytes: number;
	private readonly maxResults: number;
	private readonly allowedExtensions: ReadonlySet<string> | undefined;

	constructor(rootPath: string, contentCache: ContentCachePort = new InMemoryContentCache(), options: TreeSitterSymbolIndexOptions = {}) {
		this.rootPath = rootPath;
		this.contentCache = contentCache;
		this.maxFiles = positiveLimit(options.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
		this.maxFileBytes = positiveLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
		this.maxTotalBytes = positiveLimit(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, "maxTotalBytes");
		this.maxResults = positiveLimit(options.maxResults, DEFAULT_MAX_RESULTS, "maxResults");
		this.allowedExtensions = options.language ? new Set(options.language.extensions) : undefined;
		this.provenance = options.language
			? {
					fidelity: "structural",
					backend: options.language.backend,
					languageId: options.language.languageId,
					authority: "parser",
					freshness: "content-hash",
					limitations: ["no cross-file identity", "no type information", "syntax recovery may include malformed declarations"],
				}
			: {
					fidelity: "structural",
					backend: "tree-sitter-typescript-javascript",
					languageId: "typescript-javascript",
					authority: "parser",
					freshness: "content-hash",
					limitations: ["no cross-file identity", "no type information", "syntax recovery may include malformed declarations"],
				};
	}

	private async contentSymbolsFor(wasmPath: string, content: string, declarationKinds: readonly DeclarationKind[]): Promise<ContentSymbol[]> {
		const hash = contentHashOf(content);

		// Reading the file already required reading its content -- warm the fs lens for this
		// hash regardless of whether the symbols lens below is a hit or a miss. Awaited, not
		// fire-and-forget: a caller reading this hash's rawContent right after findSymbols
		// resolves must see it, not race an in-flight write.
		await this.contentCache.putRawContent(hash, content);

		const cached = await this.contentCache.get(hash);
		if (cached?.symbols) return [...cached.symbols];

		const parser = await parserForWasmPath(wasmPath);
		const tree = parser.parse(content);
		const symbols = extractContentSymbols(tree.rootNode, declarationKinds);
		await this.contentCache.putSymbols(hash, symbols);
		return symbols;
	}

	async findSymbols(query: string, bounds: SymbolSearchBounds = { maxResults: this.maxResults }): Promise<SymbolSearchResult> {
		const maxResults = Math.min(positiveLimit(bounds.maxResults, this.maxResults, "maxResults"), this.maxResults);
		const lowerQuery = query.toLowerCase();
		const results: WorkspaceSymbol[] = [];
		const matchesScope = (extension: string) =>
			wasmPathForExtension(extension) !== undefined && (!this.allowedExtensions || this.allowedExtensions.has(extension));
		const files = findSourceFiles(this.rootPath, matchesScope, this.maxFiles);
		let totalBytes = 0;
		let truncated = files.length === this.maxFiles;

		for (const relativePath of files) {
			const extension = extname(relativePath);
			const wasmPath = wasmPathForExtension(extension);
			if (!wasmPath) continue;

			let content: string;
			try {
				const absolutePath = join(this.rootPath, relativePath);
				const size = statSync(absolutePath).size;
				if (size > this.maxFileBytes || totalBytes + size > this.maxTotalBytes) {
					truncated = true;
					continue;
				}
				totalBytes += size;
				content = readFileSync(absolutePath, "utf-8");
			} catch {
				continue;
			}

			const contentSymbols = await this.contentSymbolsFor(wasmPath, content, declarationKindsForExtension(extension));
			for (const symbol of toWorkspaceSymbols(contentSymbols, relativePath)) {
				if (!symbol.name.toLowerCase().includes(lowerQuery)) continue;
				if (results.length === maxResults) {
					truncated = true;
					break;
				}
				results.push(symbol);
			}
			if (results.length === maxResults) break;
		}

		return { symbols: results, truncated, provenance: this.provenance };
	}

	async close(): Promise<void> {
		// In-process, synchronous parsing -- no subprocess or handle to release.
	}
}
