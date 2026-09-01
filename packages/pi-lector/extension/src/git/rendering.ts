import type { GitDiffResult, GitLogEntry, GitStatusSummary, OperationOutputs } from "@danypops/lector";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderDiffLines, renderTruncatedList, type TextMeasure } from "malevich-tui-components";
import type { LectorTheme } from "../lector-tui-theme.ts";
import { presentationTitle } from "../presentation/tool-presentation.ts";

/** Real ANSI-aware measurement, not Malevich's own ASCII-only default -- every diff line renderDiffLines receives is already theme.fg-styled. */
const measure: TextMeasure = { visibleWidth, truncateToWidth };

const DEFAULT_VISIBLE_FILES = 20;
const DEFAULT_VISIBLE_COMMITS = 10;
const DEFAULT_VISIBLE_DIFF_LINES = 60;

export type GitAction =
	| "status"
	| "log"
	| "diff"
	| "compare-symbol"
	| "worktree-add"
	| "worktree-remove"
	| "show"
	| "grep-ref"
	| "grep-history"
	| "ls-ref"
	| "is-ancestor";

type SymbolComparison = OperationOutputs["workspace.compareSymbolAcrossVersions"];
type GitWorktreeAddResult = OperationOutputs["workspace.gitWorktreeAdd"];
type GitWorktreeRemoveResult = OperationOutputs["workspace.gitWorktreeRemove"];
type GitGrepResult = OperationOutputs["workspace.gitGrep"];
type GitHistoryGrepResult = OperationOutputs["workspace.gitGrepHistory"];
type GitListFilesResult = OperationOutputs["workspace.gitListFiles"];

export interface GitToolDetails {
	readonly action: GitAction;
	readonly summary?: GitStatusSummary;
	readonly entries?: readonly GitLogEntry[];
	readonly result?: GitDiffResult;
	readonly comparison?: SymbolComparison;
	readonly worktreeAdd?: GitWorktreeAddResult;
	readonly worktreeRemove?: GitWorktreeRemoveResult;
	readonly showFile?: { readonly ref: string; readonly path: string; readonly content: string | undefined };
	readonly grep?: GitGrepResult;
	readonly historyGrep?: GitHistoryGrepResult;
	readonly listFiles?: GitListFilesResult;
	readonly isAncestor?: { readonly ancestorRef: string; readonly ref: string; readonly result: boolean };
}

export function formatGitCall(
	args: {
		action?: unknown;
		directory?: unknown;
		ref?: unknown;
		path?: unknown;
		symbol?: unknown;
		fromRef?: unknown;
		toRef?: unknown;
		pattern?: unknown;
		ancestorRef?: unknown;
	},
	theme: LectorTheme,
): string {
	const action = typeof args.action === "string" ? args.action : "";
	const label = theme.fg("toolTitle", theme.bold(presentationTitle("git", action)));
	const directory = typeof args.directory === "string" ? args.directory : "";
	if (action === "compare-symbol") {
		const path = typeof args.path === "string" ? args.path : "";
		const symbol = typeof args.symbol === "string" ? args.symbol : "";
		const fromRef = typeof args.fromRef === "string" ? args.fromRef : "";
		const toRef = typeof args.toRef === "string" ? ` -> ${args.toRef}` : "";
		return `${label} ${theme.fg("accent", `${directory}/${path}`)} (${symbol}) ${fromRef}${toRef}`;
	}
	if (action === "is-ancestor") {
		const ancestorRef = typeof args.ancestorRef === "string" ? args.ancestorRef : "";
		const ref = typeof args.ref === "string" ? args.ref : "";
		return `${label} ${theme.fg("accent", directory)} ${ancestorRef} -> ${ref}`;
	}
	if (action === "grep-ref" || action === "grep-history") {
		const ref = action === "grep-ref" && typeof args.ref === "string" ? `${args.ref} ` : "";
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		return `${label} ${theme.fg("accent", directory)} ${ref}"${pattern}"`;
	}
	if (action === "show") {
		const ref = typeof args.ref === "string" ? args.ref : "";
		const path = typeof args.path === "string" ? args.path : "";
		return `${label} ${theme.fg("accent", `${directory}/${path}`)} @ ${ref}`;
	}
	const ref = typeof args.ref === "string" ? ` ${args.ref}` : "";
	return `${label} ${theme.fg("accent", directory)}${ref}`;
}

function formatGitWorktreeAddResult(result: GitWorktreeAddResult | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	const verb = result.created ? "created" : "reused existing";
	return [theme.fg("accent", `${verb} worktree at ${result.ref} (${result.commit.slice(0, 8)})`), theme.fg("muted", result.path)].join("\n");
}

function formatGitWorktreeRemoveResult(result: GitWorktreeRemoveResult | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	return theme.fg("accent", "worktree removed");
}

function formatGitShowFileResult(details: GitToolDetails["showFile"], theme: LectorTheme): string {
	if (!details) return theme.fg("dim", "No result.");
	if (details.content === undefined) return theme.fg("dim", `"${details.path}" does not exist at ${details.ref}`);
	return details.content;
}

function formatGitGrepResult(result: GitGrepResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result || result.matches.length === 0) return theme.fg("dim", "No matches.");
	const lines = renderTruncatedList({
		items: result.matches,
		expanded,
		visibleCount: DEFAULT_VISIBLE_FILES,
		formatItem: (match) => `${theme.fg("accent", `${match.path}:${match.line}`)}:${match.text}`,
		moreLine: moreLine(theme),
		truncationWarning: result.truncated ? theme.fg("warning", "(also bounded by maxMatches/maxBytes)") : undefined,
	});
	return lines.join("\n");
}

function formatGitHistoryGrepResult(result: GitHistoryGrepResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result || result.matches.length === 0) {
		if (result?.deadlineReached) return theme.fg("warning", "No matches before the deadline.");
		return theme.fg("dim", "No historical matches.");
	}
	const lines = renderTruncatedList({
		items: result.matches,
		expanded,
		visibleCount: DEFAULT_VISIBLE_FILES,
		formatItem: (match) => {
			const occurrences = match.occurrences > 1 ? ` (${match.occurrences} commits)` : "";
			return `${theme.fg("muted", match.commit.slice(0, 8))} ${theme.fg("accent", `${match.path}:${match.line}`)}:${match.text}${occurrences}`;
		},
		moreLine: moreLine(theme),
		truncationWarning: result.deadlineReached
			? theme.fg("warning", "(deadline reached)")
			: result.truncated
				? theme.fg("warning", "(bounded by maxMatches/maxBytes)")
				: undefined,
	});
	if (result.nextCommitOffset !== undefined) lines.push(theme.fg("muted", `next commit offset: ${result.nextCommitOffset}`));
	return lines.join("\n");
}

function formatGitListFilesResult(result: GitListFilesResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result || result.paths.length === 0) return theme.fg("dim", "No files.");
	const lines = renderTruncatedList({
		items: result.paths,
		expanded,
		visibleCount: DEFAULT_VISIBLE_FILES,
		formatItem: (path) => path,
		moreLine: moreLine(theme),
		truncationWarning: result.truncated ? theme.fg("warning", "(bounded by maxResults)") : undefined,
	});
	return lines.join("\n");
}

function formatGitIsAncestorResult(details: GitToolDetails["isAncestor"], theme: LectorTheme): string {
	if (!details) return theme.fg("dim", "No result.");
	const verb = details.result ? "is" : "is not";
	return theme.fg("accent", `${details.ancestorRef} ${verb} an ancestor of ${details.ref}`);
}

export function formatGitResult(details: GitToolDetails | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!details) return theme.fg("dim", "No result.");
	if (details.action === "status") return formatGitStatusResult(details.summary, expanded, theme);
	if (details.action === "log") return formatGitLogResult(details.entries, expanded, theme);
	if (details.action === "compare-symbol") return formatCompareSymbolResult(details.comparison, expanded, theme);
	if (details.action === "worktree-add") return formatGitWorktreeAddResult(details.worktreeAdd, theme);
	if (details.action === "worktree-remove") return formatGitWorktreeRemoveResult(details.worktreeRemove, theme);
	if (details.action === "show") return formatGitShowFileResult(details.showFile, theme);
	if (details.action === "grep-ref") return formatGitGrepResult(details.grep, expanded, theme);
	if (details.action === "grep-history") return formatGitHistoryGrepResult(details.historyGrep, expanded, theme);
	if (details.action === "ls-ref") return formatGitListFilesResult(details.listFiles, expanded, theme);
	if (details.action === "is-ancestor") return formatGitIsAncestorResult(details.isAncestor, theme);
	return formatGitDiffResult(details.result, expanded, theme);
}

function moreLine(theme: LectorTheme): (hidden: number) => string {
	return (hidden) => theme.fg("dim", `... ${hidden} more (${keyHint("app.tools.expand", "to expand")})`);
}

function formatGitStatusResult(summary: GitStatusSummary | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!summary) return theme.fg("dim", "No status available.");
	const branch = summary.current ?? "(detached)";
	const tracking = summary.tracking ? `, tracking ${summary.tracking} (+${summary.ahead}/-${summary.behind})` : "";
	const lines = [theme.fg("accent", `On branch ${branch}${tracking}`)];
	if (summary.files.length === 0) {
		lines.push(theme.fg("dim", "working tree clean"));
		return lines.join("\n");
	}
	lines.push(
		...renderTruncatedList({
			items: summary.files,
			expanded,
			visibleCount: DEFAULT_VISIBLE_FILES,
			formatItem: (file) => {
				const code = `${file.indexStatus}${file.workingDirStatus}`;
				return file.renamedFrom ? `${code} ${file.renamedFrom} -> ${file.path}` : `${code} ${file.path}`;
			},
			moreLine: moreLine(theme),
		}),
	);
	return lines.join("\n");
}

function formatGitLogResult(entries: readonly GitLogEntry[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!entries || entries.length === 0) return theme.fg("dim", "No commits found.");
	const lines = renderTruncatedList({
		items: entries,
		expanded,
		visibleCount: DEFAULT_VISIBLE_COMMITS,
		formatItem: (entry) => `${theme.fg("accent", entry.sha.slice(0, 8))} ${entry.authoredAt} ${entry.authorName} -- ${entry.message}`,
		moreLine: moreLine(theme),
	});
	return lines.join("\n");
}

/**
 * formatGitDiffResult returns a plain string (like every other renderer in
 * this file), fed into a Text component by index.ts -- Text word-wraps to
 * whatever width the host renders at, same as before this change. A real
 * per-line width-aware ellipsis-truncation (the way Diff is meant to be
 * used against a real terminal width, matching how Table already truncates
 * an oversized cell) isn't available at this string-building stage, since
 * renderResult's context carries no terminal width. Number.MAX_SAFE_INTEGER
 * here means renderDiffLines' own truncation never fires -- a
 * pathologically long single line still gets word-wrapped by Text rather
 * than ellipsis-truncated, exactly as it did before this migration. This
 * migration's actual scope is real +/- coloring; rendering git_diff as a
 * genuine width-aware Component (fixing the wrap-vs-truncate tradeoff too)
 * is the still-open "render file and Git diffs as bounded native Pi
 * visuals" follow-up.
 */
/** Shared by formatGitDiffResult and formatCompareSymbolResult -- both display a real unified-diff string, styled and bounded the same way. */
function renderStyledDiffLines(diff: string, truncatedUpstream: boolean, expanded: boolean, theme: LectorTheme): string {
	const styledLines = renderDiffLines(
		Number.MAX_SAFE_INTEGER,
		diff,
		{
			add: (s) => theme.fg("success", s),
			remove: (s) => theme.fg("error", s),
			context: (s) => theme.fg("dim", s),
			hunk: (s) => theme.fg("accent", s),
			header: (s) => theme.fg("muted", s),
		},
		measure,
	);
	const lines = renderTruncatedList({
		items: styledLines,
		expanded,
		visibleCount: DEFAULT_VISIBLE_DIFF_LINES,
		formatItem: (line) => line,
		moreLine: (hidden) => theme.fg("dim", `... ${hidden} more line${hidden === 1 ? "" : "s"} (${keyHint("app.tools.expand", "to expand")})`),
		truncationWarning: truncatedUpstream ? theme.fg("warning", "(diff output itself was truncated by maxBytes)") : undefined,
	});
	return lines.join("\n");
}

function formatGitDiffResult(result: GitDiffResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result || result.diff.length === 0) return theme.fg("dim", "No differences.");
	return renderStyledDiffLines(result.diff, result.truncated, expanded, theme);
}

function formatCompareSymbolResult(comparison: SymbolComparison | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!comparison) return theme.fg("dim", "No result.");
	const header = theme.fg("accent", `${comparison.path} (${comparison.symbolName}) -- ${comparison.fromRef} -> ${comparison.toRef}`);
	if (comparison.status === "both-missing") return `${header}\n${theme.fg("dim", "symbol found at neither version")}`;
	if (comparison.status === "unchanged") return `${header}\n${theme.fg("dim", "unchanged")}`;
	return `${header}\n${renderStyledDiffLines(comparison.diff, comparison.truncated, expanded, theme)}`;
}
