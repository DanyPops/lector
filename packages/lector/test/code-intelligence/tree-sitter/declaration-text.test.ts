import { describe, expect, it } from "bun:test";
import { extractDeclarationSnapshot } from "../../../src/code-intelligence/tree-sitter/declaration-text.ts";

describe("extractDeclarationSnapshot", () => {
	it("returns found:false when the symbol name does not appear in any declaration", async () => {
		const result = await extractDeclarationSnapshot("function foo() {}", ".ts", "bar");
		expect(result.found).toBe(false);
	});

	it("extracts the exact declaration source text for a matching top-level function", async () => {
		const content = "const x = 1;\nfunction greet(name: string): string {\n\treturn `hi ${name}`;\n}\n";
		const result = await extractDeclarationSnapshot(content, ".ts", "greet");
		expect(result.found).toBe(true);
		expect(result.text).toBe("function greet(name: string): string {\n\treturn `hi ${name}`;\n}");
		expect(result.startLine).toBe(2);
		expect(result.endLine).toBe(4);
	});

	it("matches a class declaration by name, not just functions", async () => {
		const content = "class Widget {\n\tsize = 1;\n}\n";
		const result = await extractDeclarationSnapshot(content, ".ts", "Widget");
		expect(result.found).toBe(true);
		expect(result.text).toContain("class Widget");
	});

	it("resolves the first occurrence deterministically when a name appears more than once", async () => {
		const content = "function dup() { return 1; }\nfunction dup() { return 2; }\n";
		const result = await extractDeclarationSnapshot(content, ".ts", "dup");
		expect(result.found).toBe(true);
		expect(result.text).toContain("return 1");
	});

	it("is exact-match, not substring -- a longer name does not match a shorter query", async () => {
		const content = "function greeting() {}\n";
		const result = await extractDeclarationSnapshot(content, ".ts", "greet");
		expect(result.found).toBe(false);
	});
});
