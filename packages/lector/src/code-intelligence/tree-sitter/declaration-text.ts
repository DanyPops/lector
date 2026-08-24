import type { SymbolDeclarationSnapshot } from "../../code-intelligence/symbol-declaration-snapshot.ts";
import { declarationKindsForExtension } from "./tree-sitter-symbol-index.ts";
import { parserForExtension } from "./typescript-parser.ts";

const NOT_FOUND: SymbolDeclarationSnapshot = { found: false };

/**
 * Extracts one named symbol's own exact declaration source text from a single version of a
 * file's content, via the same tree-sitter grammar TreeSitterSymbolIndex uses -- deliberately
 * independent of any real checkout: the caller may have gotten `content` from a git blob
 * (GitPort.showFile) just as easily as from disk. `extension` must already be one
 * parserForExtension recognizes; an unsupported extension throws (validated by the caller
 * upfront, same convention as the rest of this adapter family).
 *
 * A name matching more than one declaration (e.g. two same-named methods on different classes)
 * resolves to the first document-order occurrence, deterministically -- a caller comparing one
 * specific symbol across versions needs exactly one answer, not a list to disambiguate.
 */
export async function extractDeclarationSnapshot(content: string, extension: string, symbolName: string): Promise<SymbolDeclarationSnapshot> {
	const parser = await parserForExtension(extension);
	if (!parser) throw new TypeError(`no tree-sitter grammar registered for extension "${extension}"`);
	const tree = parser.parse(content);
	for (const spec of declarationKindsForExtension(extension)) {
		for (const node of tree.rootNode.descendantsOfType(spec.nodeType)) {
			const nameNode = node.childForFieldName("name");
			if (nameNode?.text !== symbolName) continue;
			return {
				found: true,
				text: content.slice(node.startIndex, node.endIndex),
				startLine: node.startPosition.row + 1,
				endLine: node.endPosition.row + 1,
			};
		}
	}
	return NOT_FOUND;
}
