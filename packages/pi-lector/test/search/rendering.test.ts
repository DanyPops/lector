import { describe, expect, it } from "bun:test";
import type { TextSearchMatch, TextSearchResult } from "@danypops/lector";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { LectorTheme } from "../../extension/src/lector-tui-theme.ts";
import { formatSearchCall, formatSearchResult } from "../../extension/src/search/rendering.ts";

initTheme();

const theme: LectorTheme = { fg: (_color, text) => text, bold: (text) => text };

function match(path: string, line: string, overrides: Partial<TextSearchMatch> = {}): TextSearchMatch {
	return { path, lineNumber: 1, line, matchStart: 0, matchEnd: line.length, ...overrides };
}

function result(overrides: Partial<TextSearchResult> = {}): TextSearchResult {
	return { matches: [], truncated: false, ...overrides };
}

describe("formatSearchCall", () => {
	it("shows the query and directory", () => {
		expect(formatSearchCall({ directory: "/repo", query: "foo" }, theme)).toContain('Search Code "foo" /repo');
	});
});

describe("formatSearchResult", () => {
	it("shows a clear message when there are no matches", () => {
		expect(formatSearchResult(result(), false, theme)).toContain("No matches found");
	});

	it("shows each match's path, line number, and line text", () => {
		const text = formatSearchResult(result({ matches: [match("a.ts", "const x = 1;\n", { lineNumber: 3 })] }), false, theme);
		expect(text).toContain("a.ts:3: const x = 1;");
	});

	it("truncates past the default visible match count and says how many more remain", () => {
		const matches = Array.from({ length: 30 }, (_, i) => match(`f${i}.ts`, "match"));
		const text = formatSearchResult(result({ matches }), false, theme);
		expect(text).toContain("more");
		expect(text).not.toContain("f29.ts");
	});

	it("shows every match when expanded", () => {
		const matches = Array.from({ length: 30 }, (_, i) => match(`f${i}.ts`, "match"));
		const text = formatSearchResult(result({ matches }), true, theme);
		expect(text).toContain("f29.ts");
	});

	it("notes upstream truncation distinctly from display-count truncation", () => {
		const text = formatSearchResult(result({ matches: [match("a.ts", "x")], truncated: true }), false, theme);
		expect(text).toContain("truncated by maxMatches/maxBytes");
	});

	it("marks an individually truncated matched line without claiming aggregate result truncation", () => {
		const text = formatSearchResult(result({ matches: [match("a.ts", "hello", { lineTruncated: true })], truncated: false }), false, theme);
		expect(text).toContain("line truncated");
		expect(text).not.toContain("results are incomplete");
	});

	it("renders a placeholder when there's no result at all", () => {
		expect(formatSearchResult(undefined, false, theme)).toContain("No matches found");
	});
});
