import { describe, expect, it } from "bun:test";
import type { FindFilesResult } from "@danypops/lector";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { formatFindFilesCall, formatFindFilesResult } from "../../extension/src/find-files/rendering.ts";
import type { LectorTheme } from "../../extension/src/lector-tui-theme.ts";

initTheme();

const theme: LectorTheme = { fg: (_color, text) => text, bold: (text) => text };

describe("formatFindFilesCall", () => {
	it("shows the patterns and directory", () => {
		expect(formatFindFilesCall({ directory: "/repo", patterns: ["*.ts"] }, theme)).toContain('find_files "*.ts" /repo');
	});
});

describe("formatFindFilesResult", () => {
	it("shows a clear message when no files matched", () => {
		expect(formatFindFilesResult({ paths: [], truncated: false }, false, theme)).toContain("No files found");
	});

	it("lists every matched path when under the default visible count", () => {
		const text = formatFindFilesResult({ paths: ["a.ts", "b.ts"], truncated: false }, false, theme);
		expect(text).toContain("a.ts");
		expect(text).toContain("b.ts");
	});

	it("truncates past the default visible count and says how many more remain", () => {
		const paths = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
		const result: FindFilesResult = { paths, truncated: false };
		const text = formatFindFilesResult(result, false, theme);
		expect(text).toContain("more");
		expect(text).not.toContain("f49.ts");
	});

	it("shows every path when expanded", () => {
		const paths = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
		const text = formatFindFilesResult({ paths, truncated: false }, true, theme);
		expect(text).toContain("f49.ts");
	});

	it("notes upstream truncation distinctly from display-count truncation", () => {
		const text = formatFindFilesResult({ paths: ["a.ts"], truncated: true }, false, theme);
		expect(text).toContain("truncated by maxResults/maxBytes");
	});

	it("renders a placeholder when there's no result at all", () => {
		expect(formatFindFilesResult(undefined, false, theme)).toContain("No files found");
	});
});
