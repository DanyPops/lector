import type Parser from "web-tree-sitter";
import { parserForExtension } from "./typescript-parser.ts";

/**
 * GraphCodeBERT's own "where-the-value-comes-from" relation names (Guo et al. 2020's DFG.py:
 * `comesFrom` for a plain identifier-to-identifier transfer -- `const x = y`/`x = y` -- and
 * `computedFrom` for anything the source expression computes from more than a bare identifier --
 * a member access, a call, a binary expression). Deliberately the same two relation names as
 * that prior art, not Lector's own invention, so a caller already familiar with GraphCodeBERT's
 * DFG can read this output directly.
 */
export type DataFlowHintKind = "comesFrom" | "computedFrom";

export interface DataFlowHint {
	readonly toVariable: string;
	readonly toStartIndex: number;
	readonly toEndIndex: number;
	readonly fromVariable: string;
	readonly fromStartIndex: number;
	readonly fromEndIndex: number;
	readonly kind: DataFlowHintKind;
}

/** `variable_declarator`'s LHS or an `assignment_expression`'s LHS -- only a bare identifier target is reported; a destructuring pattern (`const { p, q } = r`) has no single target identifier to report a hint against and is skipped entirely rather than guessed at. */
function targetIdentifier(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
	return node.type === "identifier" ? node : undefined;
}

/**
 * One heuristic hint per assignment-shaped statement whose source expression is small enough to
 * name a single clear origin: an RHS that is itself a bare identifier (`comesFrom`), or a member
 * access whose own object is a bare identifier (`computedFrom` -- `a.b`'s value is computed from
 * `a`, GraphCodeBERT's own worked example). Every other RHS shape (a call, a binary expression, a
 * literal, a destructuring source) is skipped, not guessed at -- this is a plain tree-sitter
 * pattern match with no scope resolution at all, so two identically-named variables in different
 * scopes are indistinguishable here; a caller needing real, scope-correct answers needs
 * CodeIntelligencePort's own LSP-backed queries instead. This function's entire value is being
 * cheap and language-uniform where LSP has nothing further to say (or isn't warm), exactly
 * GraphCodeBERT's own tradeoff for its DFG.py, not a replacement for it.
 */
function hintForSource(target: Parser.SyntaxNode, source: Parser.SyntaxNode): DataFlowHint | undefined {
	if (source.type === "identifier") {
		return {
			toVariable: target.text,
			toStartIndex: target.startIndex,
			toEndIndex: target.endIndex,
			fromVariable: source.text,
			fromStartIndex: source.startIndex,
			fromEndIndex: source.endIndex,
			kind: "comesFrom",
		};
	}
	if (source.type === "member_expression") {
		const object = source.childForFieldName("object");
		if (object?.type === "identifier") {
			return {
				toVariable: target.text,
				toStartIndex: target.startIndex,
				toEndIndex: target.endIndex,
				fromVariable: object.text,
				fromStartIndex: object.startIndex,
				fromEndIndex: object.endIndex,
				kind: "computedFrom",
			};
		}
	}
	return undefined;
}

/**
 * Every plain-assignment data-flow hint in `source`, via a real tree-sitter parse -- a
 * GraphCodeBERT-DFG-shaped heuristic (see DataFlowHintKind's own doc comment), not a real
 * scope-resolved dataflow graph. Covers `variable_declarator` (`const x = y;`) and
 * `assignment_expression` (`x = y;`) -- the two node shapes tree-sitter itself distinguishes for
 * "declares/rebinds one name to one expression's value", the same shapes import-specifiers.ts's
 * own STATIC_IMPORT_EXPORT_NODE_TYPES precedent scopes itself to for its own concern. Returns an
 * empty array, never throws, for an extension with no registered grammar.
 */
export async function findDataFlowHints(source: string, extension: string): Promise<DataFlowHint[]> {
	const parser = await parserForExtension(extension);
	if (!parser) return [];

	const tree = parser.parse(source);
	const hints: DataFlowHint[] = [];

	for (const declarator of tree.rootNode.descendantsOfType("variable_declarator")) {
		const name = declarator.childForFieldName("name");
		const value = declarator.childForFieldName("value");
		const target = name ? targetIdentifier(name) : undefined;
		if (!target || !value) continue;
		const hint = hintForSource(target, value);
		if (hint) hints.push(hint);
	}

	for (const assignment of tree.rootNode.descendantsOfType("assignment_expression")) {
		const left = assignment.childForFieldName("left");
		const right = assignment.childForFieldName("right");
		const target = left ? targetIdentifier(left) : undefined;
		if (!target || !right) continue;
		const hint = hintForSource(target, right);
		if (hint) hints.push(hint);
	}

	return hints.sort((a, b) => a.toStartIndex - b.toStartIndex);
}
