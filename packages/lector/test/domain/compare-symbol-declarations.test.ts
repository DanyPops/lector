import { describe, expect, it } from "bun:test";
import { compareSymbolDeclarations } from "../../src/domain/compare-symbol-declarations.ts";
import type { SymbolDeclarationSnapshot } from "../../src/domain/symbol-declaration-snapshot.ts";

const NOT_FOUND: SymbolDeclarationSnapshot = { found: false };

function found(text: string): SymbolDeclarationSnapshot {
	return { found: true, text, startLine: 1, endLine: text.split("\n").length };
}

describe("compareSymbolDeclarations", () => {
	it("reports both-missing with no diff when the symbol exists at neither version", () => {
		const result = compareSymbolDeclarations("a.ts", "sym", "v1", "v2", NOT_FOUND, NOT_FOUND, 10_000);
		expect(result.status).toBe("both-missing");
		expect(result.diff).toBe("");
		expect(result.truncated).toBe(false);
	});

	it("reports unchanged with no diff when the declaration text is byte-identical", () => {
		const snapshot = found("function foo() {}");
		const result = compareSymbolDeclarations("a.ts", "sym", "v1", "v2", snapshot, snapshot, 10_000);
		expect(result.status).toBe("unchanged");
		expect(result.diff).toBe("");
	});

	it("reports added with a real unified diff when only the 'to' side has the symbol", () => {
		const result = compareSymbolDeclarations("a.ts", "sym", "v1", "v2", NOT_FOUND, found("function foo() {}"), 10_000);
		expect(result.status).toBe("added");
		expect(result.diff).toContain("+function foo() {}");
	});

	it("reports removed with a real unified diff when only the 'from' side has the symbol", () => {
		const result = compareSymbolDeclarations("a.ts", "sym", "v1", "v2", found("function foo() {}"), NOT_FOUND, 10_000);
		expect(result.status).toBe("removed");
		expect(result.diff).toContain("-function foo() {}");
	});

	it("reports changed with a real unified diff when the declaration text differs on both sides", () => {
		const result = compareSymbolDeclarations("a.ts", "sym", "v1", "v2", found("function foo() { return 1; }"), found("function foo() { return 2; }"), 10_000);
		expect(result.status).toBe("changed");
		expect(result.diff).toContain("-function foo() { return 1; }");
		expect(result.diff).toContain("+function foo() { return 2; }");
	});

	it("labels the diff's own file headers with the two version labels, not a generic filename", () => {
		const result = compareSymbolDeclarations("a.ts", "sym", "abc123", "working tree", found("x"), found("y"), 10_000);
		expect(result.diff).toContain("abc123");
		expect(result.diff).toContain("working tree");
	});

	it("truncates a diff exceeding maxBytes and reports truncated", () => {
		const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
		const bigger = Array.from({ length: 500 }, (_, i) => `line ${i} changed`).join("\n");
		const result = compareSymbolDeclarations("a.ts", "sym", "v1", "v2", found(big), found(bigger), 100);
		expect(result.truncated).toBe(true);
		expect(result.diff.length).toBe(100);
	});
});
