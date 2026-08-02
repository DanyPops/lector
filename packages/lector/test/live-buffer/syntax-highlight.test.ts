import { describe, expect, it } from "bun:test";
import { highlightSpans, JAVASCRIPT_HIGHLIGHT_QUERY, TYPESCRIPT_HIGHLIGHT_QUERY } from "../../src/live-buffer/syntax-highlight.ts";
import { createTreeSitterQueryHarness } from "../support/tree-sitter-query-harness.ts";

describe("the exported highlight queries compile against their real grammars", () => {
	it("TYPESCRIPT_HIGHLIGHT_QUERY compiles against the TypeScript grammar", async () => {
		const harness = await createTreeSitterQueryHarness(".ts");
		expect(() => harness.compile(TYPESCRIPT_HIGHLIGHT_QUERY)).not.toThrow();
	});

	it("JAVASCRIPT_HIGHLIGHT_QUERY compiles against the JavaScript grammar", async () => {
		const harness = await createTreeSitterQueryHarness(".js");
		expect(() => harness.compile(JAVASCRIPT_HIGHLIGHT_QUERY)).not.toThrow();
	});
});

describe("highlightSpans", () => {
	it("returns no spans for an extension with no registered grammar", async () => {
		const spans = await highlightSpans("whatever content", ".unknownext");
		expect(spans).toEqual([]);
	});

	it("captures keywords in a TypeScript snippet", async () => {
		const source = "export function greet() { return 1; }";
		const spans = await highlightSpans(source, ".ts");
		const keywordTexts = spans.filter((s) => s.capture === "keyword").map((s) => source.slice(s.startIndex, s.endIndex));
		expect(keywordTexts).toContain("export");
		expect(keywordTexts).toContain("function");
		expect(keywordTexts).toContain("return");
	});

	it("captures a line comment", async () => {
		const source = "// a real comment\nconst x = 1;";
		const spans = await highlightSpans(source, ".ts");
		const comment = spans.find((s) => s.capture === "comment");
		if (!comment) throw new Error("expected a comment capture");
		expect(source.slice(comment.startIndex, comment.endIndex)).toBe("// a real comment");
	});

	it("captures string and template-string literals", async () => {
		const source = 'const a = "hello"; const b = `hi ${a}`;';
		const spans = await highlightSpans(source, ".ts");
		const strings = spans.filter((s) => s.capture === "string").map((s) => source.slice(s.startIndex, s.endIndex));
		expect(strings).toContain('"hello"');
		expect(strings.some((s) => s.startsWith("`hi"))).toBe(true);
	});

	it("captures a number literal", async () => {
		const source = "const n = 42;";
		const spans = await highlightSpans(source, ".ts");
		const numbers = spans.filter((s) => s.capture === "number").map((s) => source.slice(s.startIndex, s.endIndex));
		expect(numbers).toContain("42");
	});

	it("captures a function declaration's own name", async () => {
		const source = "function greet() {}";
		const spans = await highlightSpans(source, ".ts");
		const functions = spans.filter((s) => s.capture === "function").map((s) => source.slice(s.startIndex, s.endIndex));
		expect(functions).toContain("greet");
	});

	it("captures a called function's name, both bare and as a method", async () => {
		const source = 'greet(); console.log("x");';
		const spans = await highlightSpans(source, ".ts");
		const functions = spans.filter((s) => s.capture === "function").map((s) => source.slice(s.startIndex, s.endIndex));
		expect(functions).toContain("greet");
		expect(functions).toContain("log");
	});

	it("captures a class name and a predefined type annotation as types", async () => {
		const source = "class Widget { count: number = 0; }";
		const spans = await highlightSpans(source, ".ts");
		const types = spans.filter((s) => s.capture === "type").map((s) => source.slice(s.startIndex, s.endIndex));
		expect(types).toContain("Widget");
		expect(types).toContain("number");
	});

	it("returns spans sorted by position", async () => {
		const source = "export function greet() { return 1; }";
		const spans = await highlightSpans(source, ".ts");
		const startIndices = spans.map((span) => span.startIndex);
		expect(startIndices).toEqual([...startIndices].sort((a, b) => a - b));
	});

	it("highlights JavaScript the same way, via the .js grammar", async () => {
		const source = "function greet() { return 1; }";
		const spans = await highlightSpans(source, ".js");
		const keywords = spans.filter((s) => s.capture === "keyword").map((s) => source.slice(s.startIndex, s.endIndex));
		expect(keywords).toContain("function");
		expect(keywords).toContain("return");
	});
});
