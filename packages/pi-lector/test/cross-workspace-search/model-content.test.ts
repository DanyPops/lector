import { describe, expect, it } from "bun:test";
import type { SymbolSearchResult, TextSearchResult, WorkspaceQueryOutcome, WorkspaceSymbol } from "@danypops/lector";
import {
	formatFindSymbolsAcrossProjectsModelContent,
	formatSearchTextAcrossProjectsModelContent,
} from "../../extension/src/cross-workspace-search/model-content.ts";
import type { CrossWorkspaceOutcome } from "../../extension/src/cross-workspace-search/operations.ts";

function symbol(name: string): WorkspaceSymbol {
	return { name, kind: "function", location: { path: "src/a.ts", line: 1, character: 2 } };
}

function entry<T>(directory: string, outcome: WorkspaceQueryOutcome<T>, collapsedWith: readonly string[] = []): CrossWorkspaceOutcome<T> {
	return { directory, workspaceId: `ws-${directory}`, collapsedWith, outcome };
}

describe("cross-workspace model content", () => {
	it("preserves bounded concrete symbols and every project outcome", () => {
		const ready: SymbolSearchResult = {
			symbols: Array.from({ length: 12 }, (_, index) => symbol(`fn${index}`)),
			truncated: true,
			provenance: {
				fidelity: "semantic",
				backend: "typescript-language-server",
				languageId: "typescript",
				authority: "language-server",
				freshness: "live-process",
				limitations: [],
			},
		};
		const text = formatFindSymbolsAcrossProjectsModelContent([
			entry("/a", { workspaceId: "ws-/a", status: "ready", result: ready }, ["/alias-a"]),
			entry("/b", { workspaceId: "ws-/b", status: "loading", message: "warming" }),
			entry("/c", { workspaceId: "ws-/c", status: "error", message: "unsupported" }),
		]);

		expect(text).toContain("Find Symbols Across Projects");
		expect(text).toContain("/a -- ready");
		expect(text).toContain("function fn0 -- src/a.ts:1:2");
		expect(text).toContain("2 more symbols omitted");
		expect(text).toContain("upstream truncated: true");
		expect(text).toContain("same workspace as: /alias-a");
		expect(text).toContain("/b -- loading: warming");
		expect(text).toContain("/c -- error: unsupported");
		expect(text).not.toContain("[nested value omitted]");
	});

	it("preserves bounded concrete matches and independent output bounds", () => {
		const ready: TextSearchResult = {
			matches: Array.from({ length: 12 }, (_, index) => ({
				path: `src/f${index}.ts`,
				lineNumber: index + 1,
				line: `match ${index}`,
				matchStart: 0,
				matchEnd: 5,
				...(index === 0 ? { lineTruncated: true as const } : {}),
			})),
			truncated: true,
			provenance: { kind: "lexical", backend: "fff", indexState: "ready", indexedFiles: 12, indexSizeBytes: 1_024 },
		};
		const text = formatSearchTextAcrossProjectsModelContent([entry("/a", { workspaceId: "ws-/a", status: "ready", result: ready })], 512);

		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(512);
		expect(text).toContain("src/f0.ts:1: match 0 (line truncated)");
		expect(text).toContain("2 more matches omitted");
		expect(text).toContain("upstream truncated: true");
		expect(text).not.toContain("[nested value omitted]");
	});
});
