import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";
import type { IntelligenceProvenance, SymbolSearchBounds } from "../domain/intelligence-provenance.ts";
import type { SymbolSearchResult, WorkspaceSymbol } from "../domain/workspace-symbol.ts";
import type { SymbolIndexPort } from "../ports/symbol-index-port.ts";
import { findSourceFiles } from "../text-search/find-source-files.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export interface TypeScriptCompilerSymbolIndexOptions {
	readonly maxFiles?: number;
	readonly maxFileBytes?: number;
	readonly maxTotalBytes?: number;
	readonly maxResults?: number;
	readonly maxNodesPerFile?: number;
}

function positiveLimit(value: number | undefined, fallback: number, field: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${field} must be a positive safe integer`);
	return result;
}

function scriptKind(path: string): ts.ScriptKind {
	switch (extname(path)) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
}

function declaration(node: ts.Node): { name: ts.Node; kind: string } | undefined {
	if (ts.isFunctionDeclaration(node) && node.name) return { name: node.name, kind: "function" };
	if (ts.isClassDeclaration(node) && node.name) return { name: node.name, kind: "class" };
	if (ts.isInterfaceDeclaration(node)) return { name: node.name, kind: "interface" };
	if (ts.isTypeAliasDeclaration(node)) return { name: node.name, kind: "type-alias" };
	if (ts.isEnumDeclaration(node)) return { name: node.name, kind: "enum" };
	if (ts.isMethodDeclaration(node)) return { name: node.name, kind: "method" };
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return { name: node.name, kind: "variable" };
	return undefined;
}

export class TypeScriptCompilerSymbolIndex implements SymbolIndexPort {
	readonly provenance: IntelligenceProvenance = {
		fidelity: "structural",
		backend: "typescript-compiler",
		languageId: "typescript-javascript",
		authority: "compiler",
		freshness: "filesystem-snapshot",
		limitations: ["syntax declarations only", "no cross-file identity", "no language-server project state"],
	};
	private readonly maxFiles: number;
	private readonly maxFileBytes: number;
	private readonly maxTotalBytes: number;
	private readonly maxResults: number;
	private readonly maxNodesPerFile: number;

	constructor(
		private readonly rootPath: string,
		options: TypeScriptCompilerSymbolIndexOptions = {},
	) {
		this.maxFiles = positiveLimit(options.maxFiles, 5_000, "maxFiles");
		this.maxFileBytes = positiveLimit(options.maxFileBytes, 2 * 1024 * 1024, "maxFileBytes");
		this.maxTotalBytes = positiveLimit(options.maxTotalBytes, 50 * 1024 * 1024, "maxTotalBytes");
		this.maxResults = positiveLimit(options.maxResults, 1_000, "maxResults");
		this.maxNodesPerFile = positiveLimit(options.maxNodesPerFile, 100_000, "maxNodesPerFile");
	}

	findSymbols(query: string, bounds: SymbolSearchBounds = { maxResults: this.maxResults }): Promise<SymbolSearchResult> {
		const maxResults = Math.min(positiveLimit(bounds.maxResults, this.maxResults, "maxResults"), this.maxResults);
		const files = findSourceFiles(this.rootPath, (extension) => SOURCE_EXTENSIONS.has(extension), this.maxFiles);
		const symbols: WorkspaceSymbol[] = [];
		const lowerQuery = query.toLowerCase();
		let totalBytes = 0;
		let truncated = files.length === this.maxFiles;

		for (const relativePath of files) {
			const absolutePath = join(this.rootPath, relativePath);
			let sourceText: string;
			try {
				const size = statSync(absolutePath).size;
				if (size > this.maxFileBytes || totalBytes + size > this.maxTotalBytes) {
					truncated = true;
					continue;
				}
				totalBytes += size;
				sourceText = readFileSync(absolutePath, "utf-8");
			} catch {
				continue;
			}

			const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind(relativePath));
			let visited = 0;
			const visit = (node: ts.Node): void => {
				if (visited++ >= this.maxNodesPerFile || symbols.length >= maxResults) {
					truncated = true;
					return;
				}
				const found = declaration(node);
				if (found) {
					const name = found.name.getText(sourceFile);
					if (name.toLowerCase().includes(lowerQuery)) {
						const position = sourceFile.getLineAndCharacterOfPosition(found.name.getStart(sourceFile));
						symbols.push({ name, kind: found.kind, location: { path: relativePath, line: position.line + 1, character: position.character + 1 } });
					}
				}
				if (visited < this.maxNodesPerFile && symbols.length < maxResults) ts.forEachChild(node, visit);
				else if (node.getChildCount(sourceFile) > 0) truncated = true;
			};
			visit(sourceFile);
			if (symbols.length >= maxResults) {
				truncated = true;
				break;
			}
		}

		return Promise.resolve({ symbols, truncated, provenance: this.provenance });
	}

	async close(): Promise<void> {}
}
