import type Parser from "web-tree-sitter";
import { parserForExtension } from "../../src/code-intelligence/tree-sitter/typescript-parser.ts";

/**
 * Reusable tree-sitter query harness: compiles a `.scm` query source against a real grammar and
 * runs it against real source text, returning captures with their text already sliced.
 *
 * Exists specifically so query correctness gets pinned down as a real, durable, re-runnable
 * test -- not a disposable script. A hand-written (or vendored) highlight query can reference a
 * node type or field name that doesn't exist in the exact grammar version Lector actually
 * ships; tree-sitter only reports that at query-compile time, so `compile()` surfaces the real
 * compiler error immediately instead of a query silently returning zero captures at runtime.
 * Reused across every language's highlight-query tests, including the future vendored corpus
 * (task 3ae4fecc's deferred scope) -- this harness is extension-parameterized, not TypeScript-specific.
 */
export interface CaptureSpan {
	readonly startIndex: number;
	readonly endIndex: number;
	readonly capture: string;
	readonly text: string;
}

export interface TreeSitterQueryHarness {
	/** Compiles `querySource` against this harness's grammar. Throws the real tree-sitter compile error on a bad pattern, unknown node type, or unknown field name. */
	compile(querySource: string): Parser.Query;
	/** Parses `source` and runs `query` (a source string, compiled once internally, or an already-compiled Query) against it. Captures come back sorted by position, with `text` already sliced from `source`. */
	captures(source: string, query: Parser.Query | string): CaptureSpan[];
}

/** Extension examples: ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs" -- whatever `wasmPathForExtension` (typescript-parser.ts) already maps to a grammar. Throws if no grammar is registered for it -- a harness for an unsupported extension is a test-authoring mistake, not a real "zero captures" case. */
export async function createTreeSitterQueryHarness(extension: string): Promise<TreeSitterQueryHarness> {
	const parser = await parserForExtension(extension);
	if (!parser) throw new Error(`No tree-sitter grammar registered for extension "${extension}"`);
	const language = parser.getLanguage();

	return {
		compile(querySource) {
			return language.query(querySource);
		},
		captures(source, query) {
			const compiled = typeof query === "string" ? language.query(query) : query;
			const tree = parser.parse(source);
			return compiled
				.captures(tree.rootNode)
				.map((capture) => ({
					startIndex: capture.node.startIndex,
					endIndex: capture.node.endIndex,
					capture: capture.name,
					text: capture.node.text,
				}))
				.sort((a, b) => a.startIndex - b.startIndex);
		},
	};
}

/** Convenience: every capture's own already-sliced text for one capture name, in position order. */
export function textsFor(spans: readonly CaptureSpan[], capture: string): string[] {
	return spans.filter((span) => span.capture === capture).map((span) => span.text);
}
