import { describe, expect, it } from "bun:test";
import type { GitDiffResult, GitLogEntry, GitStatusSummary } from "@danypops/lector";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { formatGitCall, formatGitResult, type GitToolDetails } from "../../extension/src/git/rendering.ts";
import type { LectorTheme } from "../../extension/src/lector-tui-theme.ts";

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
	function diff(result: Omit<GitDiffResult, "files">): GitToolDetails {
		return { action: "diff", result: { ...result, files: [] } };
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

describe("formatGitResult -- compare-symbol", () => {
	function compareSymbol(overrides: Partial<GitToolDetails["comparison"]> = {}): GitToolDetails {
		return {
			action: "compare-symbol",
			comparison: { path: "a.ts", symbolName: "greet", fromRef: "v1", toRef: "v2", status: "changed", diff: "", truncated: false, ...overrides },
		};
	}

	it("reports the symbol, path, and both version labels", () => {
		const text = formatGitResult(compareSymbol(), false, theme);
		expect(text).toContain("a.ts");
		expect(text).toContain("greet");
		expect(text).toContain("v1");
		expect(text).toContain("v2");
	});

	it("renders the real diff text for a changed symbol", () => {
		const diffText = ["@@ -1,1 +1,1 @@", "-return 'hi';", "+return 'hello';"].join("\n");
		const text = formatGitResult(compareSymbol({ status: "changed", diff: diffText }), false, theme);
		expect(text).toContain("-return 'hi';");
		expect(text).toContain("+return 'hello';");
	});

	it("shows a clear message with no diff lines for both-missing", () => {
		const text = formatGitResult(compareSymbol({ status: "both-missing", diff: "" }), false, theme);
		expect(text).toContain("neither version");
	});

	it("shows a clear message with no diff lines for unchanged", () => {
		const text = formatGitResult(compareSymbol({ status: "unchanged", diff: "" }), false, theme);
		expect(text).toContain("unchanged");
	});
});

describe("formatGitResult -- worktree-add", () => {
	it("reports a newly created worktree's ref, commit, and path", () => {
		const details: GitToolDetails = {
			action: "worktree-add",
			worktreeAdd: { workspaceId: "abc123", path: "/tmp/lector-worktrees/repo/release-4.20", ref: "release-4.20", commit: "a".repeat(40), created: true },
		};
		const text = formatGitResult(details, false, theme);
		expect(text).toContain("created worktree at release-4.20");
		expect(text).toContain("aaaaaaaa");
		expect(text).toContain("/tmp/lector-worktrees/repo/release-4.20");
	});

	it("distinguishes a reused worktree from a newly created one", () => {
		const details: GitToolDetails = {
			action: "worktree-add",
			worktreeAdd: { workspaceId: "abc123", path: "/tmp/repo/main", ref: "main", commit: "b".repeat(40), created: false },
		};
		expect(formatGitResult(details, false, theme)).toContain("reused existing worktree");
	});
});

describe("formatGitResult -- worktree-remove", () => {
	it("reports the worktree was removed", () => {
		const details: GitToolDetails = {
			action: "worktree-remove",
			worktreeRemove: { workspaceId: "abc123", closedIndexes: 0, closedGraph: false, closedWatch: false },
		};
		expect(formatGitResult(details, false, theme)).toContain("worktree removed");
	});
});

describe("formatGitResult -- show", () => {
	it("shows a path's real content at a ref", () => {
		const details: GitToolDetails = { action: "show", showFile: { ref: "HEAD", path: "a.txt", content: "hello\n" } };
		expect(formatGitResult(details, false, theme)).toBe("hello\n");
	});

	it("reports a clear message when the path does not exist at that ref", () => {
		const details: GitToolDetails = { action: "show", showFile: { ref: "HEAD", path: "missing.txt", content: undefined } };
		expect(formatGitResult(details, false, theme)).toContain("does not exist at HEAD");
	});
});

describe("formatGitResult -- grep-ref", () => {
	it("shows a clear message when there are no matches", () => {
		const details: GitToolDetails = { action: "grep-ref", grep: { matches: [], truncated: false } };
		expect(formatGitResult(details, false, theme)).toContain("No matches");
	});

	it("shows path/line/text for each match", () => {
		const details: GitToolDetails = {
			action: "grep-ref",
			grep: { matches: [{ path: "a.go", line: 12, text: "LocalHoldoverTimeout = 100" }], truncated: false },
		};
		const text = formatGitResult(details, false, theme);
		expect(text).toContain("a.go:12");
		expect(text).toContain("LocalHoldoverTimeout = 100");
	});

	it("notes truncation distinctly", () => {
		const details: GitToolDetails = { action: "grep-ref", grep: { matches: [{ path: "a.go", line: 1, text: "x" }], truncated: true } };
		expect(formatGitResult(details, false, theme)).toContain("bounded by maxMatches");
	});
});

describe("formatGitResult -- grep-history", () => {
	it("shows commit provenance, occurrence counts, and continuation", () => {
		const details: GitToolDetails = {
			action: "grep-history",
			historyGrep: {
				matches: [{ path: "a.go", line: 12, text: "historical needle", commit: "1234567890abcdef", occurrences: 3 }],
				scannedCommits: 20,
				commitsTruncated: true,
				nextCommitOffset: 20,
				truncated: false,
				deadlineReached: false,
				provenance: {
					scope: "all-refs",
					traversal: "topo-order",
					binaryFiles: "excluded",
					deduplication: "path-line-text",
					commitOffset: 0,
				},
			},
		};
		const text = formatGitResult(details, false, theme);
		expect(text).toContain("12345678");
		expect(text).toContain("a.go:12");
		expect(text).toContain("3 commits");
		expect(text).toContain("next commit offset: 20");
	});
});

describe("formatGitResult -- ls-ref", () => {
	it("shows a clear message when there are no files", () => {
		const details: GitToolDetails = { action: "ls-ref", listFiles: { paths: [], truncated: false } };
		expect(formatGitResult(details, false, theme)).toContain("No files");
	});

	it("lists every real path", () => {
		const details: GitToolDetails = { action: "ls-ref", listFiles: { paths: ["a.go", "b.go"], truncated: false } };
		const text = formatGitResult(details, false, theme);
		expect(text).toContain("a.go");
		expect(text).toContain("b.go");
	});

	it("notes truncation distinctly", () => {
		const details: GitToolDetails = { action: "ls-ref", listFiles: { paths: ["a.go"], truncated: true } };
		expect(formatGitResult(details, false, theme)).toContain("bounded by maxResults");
	});
});

describe("formatGitResult -- is-ancestor", () => {
	it("reports a real ancestor relationship", () => {
		const details: GitToolDetails = { action: "is-ancestor", isAncestor: { ancestorRef: "main", ref: "release-4.20", result: true } };
		expect(formatGitResult(details, false, theme)).toContain("main is an ancestor of release-4.20");
	});

	it("reports a real non-ancestor relationship", () => {
		const details: GitToolDetails = { action: "is-ancestor", isAncestor: { ancestorRef: "release-4.20", ref: "main", result: false } };
		expect(formatGitResult(details, false, theme)).toContain("release-4.20 is not an ancestor of main");
	});
});

describe("formatGitResult -- no details", () => {
	it("shows a placeholder when there's no result at all", () => {
		expect(formatGitResult(undefined, false, theme)).toContain("No result");
	});
});
