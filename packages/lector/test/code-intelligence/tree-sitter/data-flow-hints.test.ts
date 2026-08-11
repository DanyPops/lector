import { describe, expect, it } from "bun:test";
import { findDataFlowHints } from "../../../src/code-intelligence/tree-sitter/data-flow-hints.ts";

describe("findDataFlowHints", () => {
	it("reports a comesFrom hint for a const declaration whose value is a bare identifier", async () => {
		const source = "const x = y;\n";
		const hints = await findDataFlowHints(source, ".ts");
		expect(hints).toEqual([
			{
				toVariable: "x",
				toStartIndex: source.indexOf("x"),
				toEndIndex: source.indexOf("x") + 1,
				fromVariable: "y",
				fromStartIndex: source.indexOf("y"),
				fromEndIndex: source.indexOf("y") + 1,
				kind: "comesFrom",
			},
		]);
	});

	it("reports a comesFrom hint for a plain reassignment (assignment_expression), not just a declaration", async () => {
		const source = "z = w;\n";
		const hints = await findDataFlowHints(source, ".ts");
		expect(hints.map((hint) => [hint.toVariable, hint.fromVariable, hint.kind])).toEqual([["z", "w", "comesFrom"]]);
	});

	it("reports a computedFrom hint when the source expression is a member access on a bare identifier", async () => {
		const source = "let a = b.c;\n";
		const hints = await findDataFlowHints(source, ".ts");
		expect(hints.map((hint) => [hint.toVariable, hint.fromVariable, hint.kind])).toEqual([["a", "b", "computedFrom"]]);
	});

	it("skips a destructuring target entirely -- no single target identifier to report a hint against", async () => {
		const source = "const { p, q } = r;\n";
		const hints = await findDataFlowHints(source, ".ts");
		expect(hints).toEqual([]);
	});

	it("skips a source expression too complex to name a single clear origin (a call, a binary expression, a literal)", async () => {
		const source = ["const fromCall = compute();", "const fromBinary = left + right;", "const fromLiteral = 42;", ""].join("\n");
		const hints = await findDataFlowHints(source, ".ts");
		expect(hints).toEqual([]);
	});

	it("finds every hint across several statements, sorted by the target's own position", async () => {
		const source = ["const second = later;", "const first = earlier;", ""].join("\n");
		const hints = await findDataFlowHints(source, ".ts");
		expect(hints.map((hint) => hint.toVariable)).toEqual(["second", "first"]);
	});

	it("returns an empty array for a file with no assignment-shaped statements at all, not an error", async () => {
		const hints = await findDataFlowHints("export function f() {}\n", ".ts");
		expect(hints).toEqual([]);
	});

	it("works for a plain .js file using the JavaScript grammar", async () => {
		const hints = await findDataFlowHints("const x = y;\n", ".js");
		expect(hints.map((hint) => [hint.toVariable, hint.fromVariable])).toEqual([["x", "y"]]);
	});

	it("returns an empty array for an extension with no available grammar, instead of throwing", async () => {
		const hints = await findDataFlowHints("let x = y;\n", ".rs");
		expect(hints).toEqual([]);
	});
});
