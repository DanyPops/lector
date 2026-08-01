import { describe, expect, it } from "bun:test";
import type { GitDiffResult, GitLogEntry, GitStatusSummary } from "@danypops/lector";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { formatGitCall, formatGitResult, type GitToolDetails } from "../extension/src/git-rendering.ts";
import type { LectorTheme } from "../extension/src/lector-tui-theme.ts";

// keyHint() (used by the truncation "more" line) reads pi's global theme singleton, independent of the LectorTheme fake below.
initTheme();

const theme: LectorTheme = { fg: (_color, text) => text, bold: (text) => text };

describe("formatGitCall", () => {
	it("shows the action, directory, and an optional ref", () => {
		expect(formatGitCall({ action: "log", directory: "/repo", ref: "main" }, theme)).toContain("git log /repo main");
	});
});

describe("formatGitResult -- status", () => {
	function status(overrides: Partial<GitStatusSummary> = {}): GitToolDetails {
		return {
			action: "status",
			summary: { files: [], ahead: 0, behind: 0, current: "main", tracking: null, ...overrides },
		};
	}

	it("reports a clean working tree", () => {
		expect(formatGitResult(status(), false, theme)).toContain("working tree clean");
	});

	it("lists modified files with their status codes", () => {
		const text = formatGitResult(status({ files: [{ path: "a.ts", indexStatus: "M", workingDirStatus: " " }] }), false, theme);
		expect(text).toContain("M  a.ts");
	});

	it("shows a rename as from -> to", () => {
		const text = formatGitResult(status({ files: [{ path: "b.ts", renamedFrom: "a.ts", indexStatus: "R", workingDirStatus: " " }] }), false, theme);
		expect(text).toContain("a.ts -> b.ts");
	});

	it("truncates past the default visible file count and says how many more remain", () => {
		const files = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}.ts`, indexStatus: "M", workingDirStatus: " " }));
		const text = formatGitResult(status({ files }), false, theme);
		expect(text).toContain("more");
		expect(text).not.toContain("f24.ts");
	});

	it("shows every file when expanded", () => {
		const files = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}.ts`, indexStatus: "M", workingDirStatus: " " }));
		const text = formatGitResult(status({ files }), true, theme);
		expect(text).toContain("f24.ts");
	});
});

describe("formatGitResult -- log", () => {
	function log(entries: GitLogEntry[]): GitToolDetails {
		return { action: "log", entries };
	}

	it("shows a clear message when there are no commits", () => {
		expect(formatGitResult(log([]), false, theme)).toContain("No commits found");
	});

	it("shows the short sha, author, and message", () => {
		const text = formatGitResult(
			log([{ sha: "1234567890abcdef", authorName: "Ada", authorEmail: "ada@example.com", authoredAt: "2026-01-01T00:00:00Z", message: "fix: thing" }]),
			false,
			theme,
		);
		expect(text).toContain("12345678");
		expect(text).toContain("Ada");
		expect(text).toContain("fix: thing");
	});

	it("truncates past the default visible commit count", () => {
		const entries = Array.from({ length: 15 }, (_, i) => ({
			sha: `${i}`.repeat(40).slice(0, 40),
			authorName: "Ada",
			authorEmail: "ada@example.com",
			authoredAt: "2026-01-01T00:00:00Z",
			message: `commit ${i}`,
		}));
		const text = formatGitResult(log(entries), false, theme);
		expect(text).toContain("more");
		expect(text).not.toContain("commit 14");
	});
});

describe("formatGitResult -- diff", () => {
	function diff(result: GitDiffResult): GitToolDetails {
		return { action: "diff", result };
	}

	const REAL_DIFF = ["@@ -1,3 +1,3 @@", " line 1", "-line 2", "+line 2 patched", " line 3"].join("\n");

	it("shows a clear message when there are no differences", () => {
		expect(formatGitResult(diff({ diff: "", truncated: false }), false, theme)).toContain("No differences");
	});

	it("renders the real diff text with added and removed lines both present", () => {
		const text = formatGitResult(diff({ diff: REAL_DIFF, truncated: false }), false, theme);
		expect(text).toContain("-line 2");
		expect(text).toContain("+line 2 patched");
	});

	it("truncates past the default visible line count and says how many more remain", () => {
		const bigDiff = Array.from({ length: 100 }, (_, i) => ` line ${i}`).join("\n");
		const text = formatGitResult(diff({ diff: bigDiff, truncated: false }), false, theme);
		expect(text).toContain("more line");
		expect(text).not.toContain("line 99");
	});

	it("shows every line when expanded", () => {
		const bigDiff = Array.from({ length: 100 }, (_, i) => ` line ${i}`).join("\n");
		const text = formatGitResult(diff({ diff: bigDiff, truncated: false }), true, theme);
		expect(text).toContain("line 99");
	});

	it("notes upstream (maxBytes) truncation distinctly from display-count truncation", () => {
		const text = formatGitResult(diff({ diff: REAL_DIFF, truncated: true }), false, theme);
		expect(text).toContain("truncated by maxBytes");
	});
});

describe("formatGitResult -- no details", () => {
	it("shows a placeholder when there's no result at all", () => {
		expect(formatGitResult(undefined, false, theme)).toContain("No result");
	});
});
