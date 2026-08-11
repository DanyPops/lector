import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { narrowedTypeAtPosition } from "../../src/code-intelligence/typescript-narrowed-type.ts";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

/** 1-indexed line/character of the first occurrence of `needle` on `lineText`'s own line within `source`. */
function positionOf(source: string, lineText: string, needle: string): { line: number; character: number } {
	const lines = source.split("\n");
	const lineIndex = lines.findIndex((candidate) => candidate.includes(lineText));
	if (lineIndex === -1) throw new Error(`line containing ${JSON.stringify(lineText)} not found`);
	const character = lines[lineIndex]?.indexOf(needle, lines[lineIndex].indexOf(lineText));
	if (character === undefined || character === -1) throw new Error(`${JSON.stringify(needle)} not found on the matched line`);
	return { line: lineIndex + 1, character: character + 1 };
}

describe("narrowedTypeAtPosition", () => {
	it("reports the real flow-narrowed type inside a typeof guard's true branch -- TypeScript's own canonical control-flow-narrowing example", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-narrowed-type-"));
		const source = [
			"export function describe(input: string | number): string {",
			'\tif (typeof input === "string") {',
			"\t\treturn input.toUpperCase();",
			"\t}",
			"\treturn input.toFixed(2);",
			"}",
			"",
		].join("\n");
		const path = join(root, "guard.ts");
		writeFileSync(path, source);

		const insideStringBranch = positionOf(source, "return input.toUpperCase()", "input");
		const result = await narrowedTypeAtPosition(path, insideStringBranch.line, insideStringBranch.character);

		expect(result).toEqual({ declaredType: "string | number", narrowedType: "string", narrowed: true });
	});

	it("reports the real flow-narrowed type in the guard's else branch too -- the complementary narrowing, not just the positive case", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-narrowed-type-else-"));
		const source = [
			"export function describe(input: string | number): string {",
			'\tif (typeof input === "string") {',
			"\t\treturn input.toUpperCase();",
			"\t}",
			"\treturn input.toFixed(2);",
			"}",
			"",
		].join("\n");
		const path = join(root, "guard.ts");
		writeFileSync(path, source);

		const insideNumberBranch = positionOf(source, "return input.toFixed(2)", "input");
		const result = await narrowedTypeAtPosition(path, insideNumberBranch.line, insideNumberBranch.character);

		expect(result).toEqual({ declaredType: "string | number", narrowedType: "number", narrowed: true });
	});

	it("reports narrowed: false at the parameter's own declaration site -- nothing has narrowed it yet", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-narrowed-type-declaration-"));
		const source = "export function describe(input: string | number): void {}\n";
		const path = join(root, "guard.ts");
		writeFileSync(path, source);

		const declaration = positionOf(source, "function describe", "input");
		const result = await narrowedTypeAtPosition(path, declaration.line, declaration.character);

		expect(result).toEqual({ declaredType: "string | number", narrowedType: "string | number", narrowed: false });
	});

	it("reports a real narrowing from a reassignment, not just a type guard", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-narrowed-type-reassignment-"));
		const source = ["export function widen(value: string | number): void {", '\tvalue = "always a string now";', "\tconsole.log(value);", "}", ""].join("\n");
		const path = join(root, "reassign.ts");
		writeFileSync(path, source);

		const afterReassignment = positionOf(source, "console.log(value)", "value");
		const result = await narrowedTypeAtPosition(path, afterReassignment.line, afterReassignment.character);

		expect(result).toEqual({ declaredType: "string | number", narrowedType: "string", narrowed: true });
	});

	it("returns undefined for a position with no identifier at all (e.g. inside whitespace or punctuation)", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-narrowed-type-no-identifier-"));
		const source = "export const x = 1;\n";
		const path = join(root, "plain.ts");
		writeFileSync(path, source);

		const result = await narrowedTypeAtPosition(path, 1, 1); // column 1, the very start -- "export" keyword, not an identifier

		expect(result).toBeUndefined();
	});

	it("throws the real filesystem error for a path that does not exist, rather than degrading to undefined", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-narrowed-type-missing-"));
		await expect(narrowedTypeAtPosition(join(root, "missing.ts"), 1, 1)).rejects.toThrow();
	});
});
