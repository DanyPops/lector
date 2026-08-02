import type Parser from "web-tree-sitter";
import { parserForExtension } from "../adapters/tree-sitter/typescript-parser.ts";

export interface HighlightSpan {
	readonly startIndex: number;
	readonly endIndex: number;
	readonly capture: string;
}

/**
 * Compact, hand-written TypeScript/JavaScript highlight queries -- deliberately NOT the full
 * vendored nvim-treesitter/Helix query corpus (see task "Lector: /editor slash command"'s
 * explicitly deferred scope: per-language vendoring, licensing attribution, and cross-checking
 * node-type compatibility across every language in Lector's priority spine is real, separate
 * follow-up work). Capture names follow the same @keyword/@string/etc. convention those corpora
 * use, so swapping in the real vendored query later is a drop-in replacement, not a rewrite.
 *
 * Every clause here is pinned down by test/live-buffer/syntax-highlight.test.ts via the shared
 * tree-sitter-query-harness -- a node type or field name that doesn't exist in the exact grammar
 * `tree-sitter-wasms` bundles fails that test immediately, not silently at runtime.
 *
 * TypeScript and JavaScript are two distinct grammars, confirmed directly via the harness (not
 * assumed): `abstract`/`enum`/`implements`/`interface`/`private`/`protected`/`public`/`readonly`/
 * `type` are valid literal keyword tokens only in the TypeScript grammar, and `type_identifier`/
 * `predefined_type` are node types that exist only in the TypeScript grammar's own node set --
 * plain JavaScript has no distinct type-annotation concept, so both are appended only for the
 * TypeScript query, never the JavaScript one.
 */
const BASE_KEYWORDS = [
	"as",
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"default",
	"delete",
	"do",
	"else",
	"export",
	"extends",
	"finally",
	"for",
	"from",
	"function",
	"get",
	"if",
	"import",
	"in",
	"instanceof",
	"let",
	"new",
	"of",
	"return",
	"set",
	"static",
	"switch",
	"throw",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"yield",
];

const TYPESCRIPT_ONLY_KEYWORDS = ["abstract", "enum", "implements", "interface", "private", "protected", "public", "readonly", "type"];

const BASE_CLAUSES = `
(comment) @comment
(string) @string
(template_string) @string
(number) @number

(function_declaration name: (identifier) @function)
(method_definition name: (property_identifier) @function)
(call_expression function: (identifier) @function)
(call_expression function: (member_expression property: (property_identifier) @function))
`;

const TYPESCRIPT_ONLY_CLAUSES = `
(type_identifier) @type
(predefined_type) @type
`;

function highlightQuerySource(keywords: readonly string[], extraClauses: string): string {
	return `
[
  ${keywords.map((keyword) => `"${keyword}"`).join(" ")}
] @keyword
${BASE_CLAUSES}
${extraClauses}
`;
}

export const JAVASCRIPT_HIGHLIGHT_QUERY = highlightQuerySource(BASE_KEYWORDS, "");
export const TYPESCRIPT_HIGHLIGHT_QUERY = highlightQuerySource([...BASE_KEYWORDS, ...TYPESCRIPT_ONLY_KEYWORDS], TYPESCRIPT_ONLY_CLAUSES);

function highlightQuerySourceForExtension(extension: string): string {
	return extension === ".ts" || extension === ".tsx" ? TYPESCRIPT_HIGHLIGHT_QUERY : JAVASCRIPT_HIGHLIGHT_QUERY;
}

const queryByExtension = new Map<string, Parser.Query>();

async function highlightQueryFor(extension: string): Promise<{ parser: Parser; query: Parser.Query } | undefined> {
	const parser = await parserForExtension(extension);
	if (!parser) return undefined;
	const cached = queryByExtension.get(extension);
	if (cached) return { parser, query: cached };
	const query = parser.getLanguage().query(highlightQuerySourceForExtension(extension));
	queryByExtension.set(extension, query);
	return { parser, query };
}

/**
 * Highlight spans for `text`, given the file extension its grammar is registered under (e.g.
 * ".ts", ".tsx", ".js"). Returns an empty array -- never throws -- for an extension with no
 * registered tree-sitter grammar, matching parserForExtension's own "never throws for an
 * unsupported extension" contract.
 */
export async function highlightSpans(text: string, extension: string): Promise<readonly HighlightSpan[]> {
	const resolved = await highlightQueryFor(extension);
	if (!resolved) return [];
	const tree = resolved.parser.parse(text);
	return resolved.query
		.captures(tree.rootNode)
		.map((capture) => ({ startIndex: capture.node.startIndex, endIndex: capture.node.endIndex, capture: capture.name }))
		.sort((a, b) => a.startIndex - b.startIndex);
}
