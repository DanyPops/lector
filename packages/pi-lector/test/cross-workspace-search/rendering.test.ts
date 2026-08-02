import { describe, expect, it } from "bun:test";
import type { SymbolSearchResult, TextSearchMatch, TextSearchResult, WorkspaceQueryOutcome, WorkspaceSymbol } from "@danypops/lector";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { CrossWorkspaceOutcome } from "../../extension/src/cross-workspace-search/operations.ts";
import {
	formatCrossWorkspaceCall,
	formatFindSymbolsAcrossProjectsResult,
	formatSearchTextAcrossProjectsResult,
} from "../../extension/src/cross-workspace-search/rendering.ts";
import type { LectorTheme } from "../../extension/src/lector-tui-theme.ts";

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

function entry<T>(directory: string, outcome: WorkspaceQueryOutcome<T>, collapsedWith: readonly string[] = []): CrossWorkspaceOutcome<T> {
	return { directory, workspaceId: outcome.workspaceId, collapsedWith, outcome };
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

	it("shows a ready workspace's own symbols, labeled by the requested directory", () => {
		const outcomes = [entry("/pkg-a", { workspaceId: "ws1", status: "ready", result: symbolResult([symbol("foo")]) })];
		const text = formatFindSymbolsAcrossProjectsResult(outcomes, false, theme);
		expect(text).toContain("/pkg-a");
		expect(text).toContain("foo");
	});

	it("shows a loading workspace's message instead of pretending it found nothing", () => {
		const outcomes = [entry<SymbolSearchResult>("/a", { workspaceId: "/a", status: "loading", message: "still warming up" })];
		expect(formatFindSymbolsAcrossProjectsResult(outcomes, false, theme)).toContain("still warming up");
	});

	it("shows an error workspace's message", () => {
		const outcomes = [entry<SymbolSearchResult>("/a", { workspaceId: "/a", status: "error", message: "unsupported language" })];
		expect(formatFindSymbolsAcrossProjectsResult(outcomes, false, theme)).toContain("unsupported language");
	});

	it("truncates a ready workspace's own symbol list past its per-workspace visible count", () => {
		const symbols = Array.from({ length: 20 }, (_, i) => symbol(`fn${i}`));
		const outcomes = [entry("/a", { workspaceId: "/a", status: "ready" as const, result: symbolResult(symbols) })];
		const text = formatFindSymbolsAcrossProjectsResult(outcomes, false, theme);
		expect(text).toContain("more");
		expect(text).not.toContain("fn19");
	});

	it("shows every symbol when expanded", () => {
		const symbols = Array.from({ length: 20 }, (_, i) => symbol(`fn${i}`));
		const outcomes = [entry("/a", { workspaceId: "/a", status: "ready" as const, result: symbolResult(symbols) })];
		expect(formatFindSymbolsAcrossProjectsResult(outcomes, true, theme)).toContain("fn19");
	});

	it("surfaces a collapsedWith collision explicitly, naming the other directory it shares a workspace with", () => {
		const shared: WorkspaceQueryOutcome<SymbolSearchResult> = { workspaceId: "ws-shared", status: "ready", result: symbolResult([symbol("foo")]) };
		const outcomes = [entry("/a", shared, ["/b"]), entry("/b", shared, ["/a"])];
		const text = formatFindSymbolsAcrossProjectsResult(outcomes, false, theme);
		expect(text).toContain("resolved to the same workspace as: /b");
		expect(text).toContain("resolved to the same workspace as: /a");
	});

	it("shows no collision note when collapsedWith is empty", () => {
		const outcomes = [entry("/a", { workspaceId: "ws-a", status: "ready" as const, result: symbolResult([symbol("foo")]) })];
		expect(formatFindSymbolsAcrossProjectsResult(outcomes, false, theme)).not.toContain("resolved to the same workspace as");
	});
});

describe("formatSearchTextAcrossProjectsResult", () => {
	function textResult(overrides: Partial<TextSearchResult> = {}): TextSearchResult {
		return { matches: [], truncated: false, ...overrides };
	}

	it("shows a clear message when there are no projects to search", () => {
		expect(formatSearchTextAcrossProjectsResult([], false, theme)).toContain("No projects to search");
	});

	it("shows a ready workspace's own matches, labeled by the requested directory", () => {
		const outcomes = [entry("/pkg-a", { workspaceId: "ws1", status: "ready" as const, result: textResult({ matches: [match("a.ts", "match")] }) })];
		const text = formatSearchTextAcrossProjectsResult(outcomes, false, theme);
		expect(text).toContain("/pkg-a");
		expect(text).toContain("a.ts:1: match");
	});

	it("notes a workspace's own upstream truncation distinctly", () => {
		const outcomes = [entry("/a", { workspaceId: "/a", status: "ready" as const, result: textResult({ matches: [match("a.ts", "x")], truncated: true }) })];
		expect(formatSearchTextAcrossProjectsResult(outcomes, false, theme)).toContain("truncated by maxMatches/maxBytes");
	});

	it("truncates a ready workspace's own match list past its per-workspace visible count", () => {
		const matches = Array.from({ length: 20 }, (_, i) => match(`f${i}.ts`, "match"));
		const outcomes = [entry("/a", { workspaceId: "/a", status: "ready" as const, result: textResult({ matches }) })];
		const text = formatSearchTextAcrossProjectsResult(outcomes, false, theme);
		expect(text).toContain("more");
		expect(text).not.toContain("f19.ts");
	});

	it("surfaces a collapsedWith collision explicitly", () => {
		const shared: WorkspaceQueryOutcome<TextSearchResult> = {
			workspaceId: "ws-shared",
			status: "ready",
			result: textResult({ matches: [match("a.ts", "x")] }),
		};
		const outcomes = [entry("/a", shared, ["/b"]), entry("/b", shared, ["/a"])];
		const text = formatSearchTextAcrossProjectsResult(outcomes, false, theme);
		expect(text).toContain("resolved to the same workspace as: /b");
		expect(text).toContain("resolved to the same workspace as: /a");
	});
});
