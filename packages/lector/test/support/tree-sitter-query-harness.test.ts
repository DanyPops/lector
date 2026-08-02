import { describe, expect, it } from "bun:test";
import { createTreeSitterQueryHarness, textsFor } from "./tree-sitter-query-harness.ts";

describe("createTreeSitterQueryHarness", () => {
	it("throws for an extension with no registered grammar", async () => {
		await expect(createTreeSitterQueryHarness(".unknownext")).rejects.toThrow(/no tree-sitter grammar/i);
	});

	it("compile() surfaces a real tree-sitter error for a query naming a field that doesn't exist on that node type", async () => {
		const harness = await createTreeSitterQueryHarness(".ts");
		// A real regression this harness exists to catch: a class declaration's name in this
		// grammar is a direct positional (type_identifier) child, not a `name:`-labeled
		// (identifier) field -- exactly the mistake a hand-written or freshly-vendored highlight
		// query can make against the wrong grammar version.
		expect(() => harness.compile("(class_declaration name: (identifier) @type)")).toThrow();
	});

	it("compile() accepts a query matching the grammar's real node shape", async () => {
		const harness = await createTreeSitterQueryHarness(".ts");
		expect(() => harness.compile("(class_declaration (type_identifier) @type)")).not.toThrow();
	});

	it("captures() returns matches with real, correctly-sliced text, sorted by position", async () => {
		const harness = await createTreeSitterQueryHarness(".ts");
		const source = "const a = 1; const b = 2;";
		const spans = harness.captures(source, "(number) @number");
		expect(textsFor(spans, "number")).toEqual(["1", "2"]);
		const [first, second] = spans;
		if (!first || !second) throw new Error("expected two number captures");
		expect(first.startIndex).toBeLessThan(second.startIndex);
	});

	it("captures() accepts a pre-compiled query, avoiding recompilation across many source snippets", async () => {
		const harness = await createTreeSitterQueryHarness(".ts");
		const compiled = harness.compile("(string) @string");
		const first = harness.captures('const a = "one";', compiled);
		const second = harness.captures('const b = "two";', compiled);
		expect(textsFor(first, "string")).toEqual(['"one"']);
		expect(textsFor(second, "string")).toEqual(['"two"']);
	});
});
