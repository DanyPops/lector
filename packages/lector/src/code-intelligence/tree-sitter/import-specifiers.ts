import type Parser from "web-tree-sitter";
import { parserForExtension } from "./typescript-parser.ts";

/** A single relative import/export specifier's exact text position, byte-offset into the source -- no quotes, e.g. "./math" not "\"./math\"". */
export interface ImportSpecifierOccurrence {
	readonly specifier: string;
	readonly startIndex: number;
	readonly endIndex: number;
}

/** Only these two node types are real static declarations; a dynamic `import(...)` call parses as a call_expression nested under an `arguments` node, structurally distinct, and is never matched here. */
const STATIC_IMPORT_EXPORT_NODE_TYPES = ["import_statement", "export_statement"] as const;

/**
 * Every static import/export declaration's own literal specifier in `source`, via a real
 * tree-sitter parse -- not a regex, so a multi-line import declaration (a common, real shape)
 * is handled correctly, and a dynamic `import(expr)`/`require(expr)` call is structurally
 * excluded rather than pattern-matched around. Returns an empty array, never throws, for an
 * extension with no registered grammar.
 */
export async function findImportSpecifiers(source: string, extension: string): Promise<ImportSpecifierOccurrence[]> {
	const parser = await parserForExtension(extension);
	if (!parser) return [];

	const tree = parser.parse(source);
	const results: ImportSpecifierOccurrence[] = [];
	for (const nodeType of STATIC_IMPORT_EXPORT_NODE_TYPES) {
		for (const declaration of tree.rootNode.descendantsOfType(nodeType)) {
			const stringNode = declaration.namedChildren.find((child: Parser.SyntaxNode) => child.type === "string");
			if (!stringNode) continue;
			const fragment = stringNode.namedChildren.find((child: Parser.SyntaxNode) => child.type === "string_fragment");
			if (!fragment) continue;
			results.push({ specifier: fragment.text, startIndex: fragment.startIndex, endIndex: fragment.endIndex });
		}
	}
	return results.sort((a, b) => a.startIndex - b.startIndex);
}
