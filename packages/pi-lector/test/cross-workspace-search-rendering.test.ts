import { describe, expect, it } from "bun:test";
import type { SymbolSearchResult, TextSearchMatch, TextSearchResult, WorkspaceQueryOutcome, WorkspaceSymbol } from "@danypops/lector";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	formatCrossWorkspaceCall,
	formatFindSymbolsAcrossProjectsResult,
	formatSearchTextAcrossProjectsResult,
} from "../extension/src/cross-workspace-search-rendering.ts";
import type { LectorTheme } from "../extension/src/lector-tui-theme.ts";

initTheme();

const theme: LectorTheme = { fg: (_color, text) => text, bold: (text) => text };

function symbol(name: string): WorkspaceSymbol {
	return { name, kind: "function", location: { path: "src/a.ts", line: 1, character: 1 } };
}

function match(path: string, line: string, overrides: Partial<TextSearchMatch> = {}): TextSearchMatch {
	return { path, lineNumber: 1, line, matchStart: 0, matchEnd: line.length, ...overrides };
}

function symbolResult(symbols: readonly WorkspaceSymbol[]): SymbolSearchResult {
	return {
		symbols,
		truncated: false,
		provenance: {
			fidelity: "semantic",
			backend: "typescript-language-server",
			languageId: "typescript",
			authority: "language-server",
			freshness: "live-process",
			limitations: [],
		},
	};
}

describe("formatCrossWorkspaceCall", () => {
	it("shows the query and project count", () => {
		expect(formatCrossWorkspaceCall({ directories: ["/a", "/b"], query: "foo" }, theme)).toContain('"foo" across 2 project(s)');
	});
});

describe("formatFindSymbolsAcrossProjectsResult", () => {
	it("shows a clear message when there are no projects to search", () => {
		expect(formatFindSymbolsAcrossProjectsResult([], false, theme)).toContain("No projects to search");
	});

	it("shows a ready workspace's own symbols", () => {
		const outcomes: WorkspaceQueryOutcome<SymbolSearchResult>[] = [{ workspaceId: "/a", status: "ready", result: symbolResult([symbol("foo")]) }];
		expect(formatFindSymbolsAcrossProjectsResult(outcomes, false, theme)).toContain("foo");
	});

	it("shows a loading workspace's message instead of pretending it found nothing", () => {
		const outcomes: WorkspaceQueryOutcome<SymbolSearchResult>[] = [{ workspaceId: "/a", status: "loading", message: "still warming up" }];
		expect(formatFindSymbolsAcrossProjectsResult(outcomes, false, theme)).toContain("still warming up");
	});

	it("shows an error workspace's message", () => {
		const outcomes: WorkspaceQueryOutcome<SymbolSearchResult>[] = [{ workspaceId: "/a", status: "error", message: "unsupported language" }];
		expect(formatFindSymbolsAcrossProjectsResult(outcomes, false, theme)).toContain("unsupported language");
	});

	it("truncates a ready workspace's own symbol list past its per-workspace visible count", () => {
		const symbols = Array.from({ length: 20 }, (_, i) => symbol(`fn${i}`));
		const outcomes: WorkspaceQueryOutcome<SymbolSearchResult>[] = [{ workspaceId: "/a", status: "ready", result: symbolResult(symbols) }];
		const text = formatFindSymbolsAcrossProjectsResult(outcomes, false, theme);
		expect(text).toContain("more");
		expect(text).not.toContain("fn19");
	});

	it("shows every symbol when expanded", () => {
		const symbols = Array.from({ length: 20 }, (_, i) => symbol(`fn${i}`));
		const outcomes: WorkspaceQueryOutcome<SymbolSearchResult>[] = [{ workspaceId: "/a", status: "ready", result: symbolResult(symbols) }];
		expect(formatFindSymbolsAcrossProjectsResult(outcomes, true, theme)).toContain("fn19");
	});
});

describe("formatSearchTextAcrossProjectsResult", () => {
	function textResult(overrides: Partial<TextSearchResult> = {}): TextSearchResult {
		return { matches: [], truncated: false, ...overrides };
	}

	it("shows a clear message when there are no projects to search", () => {
		expect(formatSearchTextAcrossProjectsResult([], false, theme)).toContain("No projects to search");
	});

	it("shows a ready workspace's own matches", () => {
		const outcomes: WorkspaceQueryOutcome<TextSearchResult>[] = [
			{ workspaceId: "/a", status: "ready", result: textResult({ matches: [match("a.ts", "match")] }) },
		];
		expect(formatSearchTextAcrossProjectsResult(outcomes, false, theme)).toContain("a.ts:1: match");
	});

	it("notes a workspace's own upstream truncation distinctly", () => {
		const outcomes: WorkspaceQueryOutcome<TextSearchResult>[] = [
			{ workspaceId: "/a", status: "ready", result: textResult({ matches: [match("a.ts", "x")], truncated: true }) },
		];
		expect(formatSearchTextAcrossProjectsResult(outcomes, false, theme)).toContain("truncated by maxMatches/maxBytes");
	});

	it("truncates a ready workspace's own match list past its per-workspace visible count", () => {
		const matches = Array.from({ length: 20 }, (_, i) => match(`f${i}.ts`, "match"));
		const outcomes: WorkspaceQueryOutcome<TextSearchResult>[] = [{ workspaceId: "/a", status: "ready", result: textResult({ matches }) }];
		const text = formatSearchTextAcrossProjectsResult(outcomes, false, theme);
		expect(text).toContain("more");
		expect(text).not.toContain("f19.ts");
	});
});
