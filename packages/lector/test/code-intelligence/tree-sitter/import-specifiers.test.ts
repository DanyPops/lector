import { describe, expect, it } from "bun:test";
import { findImportSpecifiers } from "../../../src/code-intelligence/tree-sitter/import-specifiers.ts";

describe("findImportSpecifiers", () => {
	it("finds a named import specifier, positioned at the text inside the quotes", async () => {
		const source = 'import { add } from "./math";\n';
		const occurrences = await findImportSpecifiers(source, ".ts");
		expect(occurrences).toEqual([{ specifier: "./math", startIndex: source.indexOf("./math"), endIndex: source.indexOf("./math") + "./math".length }]);
	});

	it("finds every static import/export form in one file", async () => {
		const source = [
			'import { a } from "./a";',
			'import type { B } from "./b";',
			'import def, { named } from "./mixed";',
			'import * as ns from "./ns";',
			'import "./side-effect";',
			'export { x } from "./reexport";',
			"export * from './barrel';",
			'export * as ns2 from "./barrel2";',
			"",
		].join("\n");

		const occurrences = await findImportSpecifiers(source, ".ts");

		expect(occurrences.map((o) => o.specifier)).toEqual(["./a", "./b", "./mixed", "./ns", "./side-effect", "./reexport", "./barrel", "./barrel2"]);
	});

	it("never includes a dynamic import(...) call, even with a literal string argument", async () => {
		const source = 'import { a } from "./a";\nconst mod = await import("./dynamic-literal");\n';
		const occurrences = await findImportSpecifiers(source, ".ts");
		expect(occurrences.map((o) => o.specifier)).toEqual(["./a"]);
	});

	it("never includes a require(...) call", async () => {
		const source = 'import { a } from "./a";\nconst mod = require("./required");\n';
		const occurrences = await findImportSpecifiers(source, ".ts");
		expect(occurrences.map((o) => o.specifier)).toEqual(["./a"]);
	});

	it("handles a multi-line import declaration -- the exact shape a naive single-line regex would miss", async () => {
		const source = 'import {\n\ta,\n\tb,\n} from "./multi-line";\n';
		const occurrences = await findImportSpecifiers(source, ".ts");
		expect(occurrences.map((o) => o.specifier)).toEqual(["./multi-line"]);
	});

	it("returns an empty array for a file with no imports at all, not an error", async () => {
		const occurrences = await findImportSpecifiers("export const x = 1;\n", ".ts");
		expect(occurrences).toEqual([]);
	});

	it("works for a .tsx file using the TSX grammar", async () => {
		const source = 'import { Component } from "./component";\n';
		const occurrences = await findImportSpecifiers(source, ".tsx");
		expect(occurrences.map((o) => o.specifier)).toEqual(["./component"]);
	});

	it("works for a plain .js file using the JavaScript grammar", async () => {
		const source = 'import { helper } from "./helper.js";\n';
		const occurrences = await findImportSpecifiers(source, ".js");
		expect(occurrences.map((o) => o.specifier)).toEqual(["./helper.js"]);
	});

	it("returns an empty array for an extension with no available grammar, instead of throwing", async () => {
		const occurrences = await findImportSpecifiers("use std::io;\n", ".rs");
		expect(occurrences).toEqual([]);
	});
});
