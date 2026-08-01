import type { GitDiffResult, GitLogEntry, GitStatusSummary } from "@danypops/lector";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderDiffLines, renderTruncatedList, type TextMeasure } from "malevich-tui-components";
import type { LectorTheme } from "./lector-tui-theme.ts";

/** Real ANSI-aware measurement, not Malevich's own ASCII-only default -- every diff line renderDiffLines receives is already theme.fg-styled. */
const measure: TextMeasure = { visibleWidth, truncateToWidth };

const DEFAULT_VISIBLE_FILES = 20;
const DEFAULT_VISIBLE_COMMITS = 10;
const DEFAULT_VISIBLE_DIFF_LINES = 60;

export type GitAction = "status" | "log" | "diff";

export interface GitToolDetails {
	readonly action: GitAction;
	readonly summary?: GitStatusSummary;
	readonly entries?: readonly GitLogEntry[];
	readonly result?: GitDiffResult;
}

export function formatGitCall(args: { action?: unknown; directory?: unknown; ref?: unknown }, theme: LectorTheme): string {
	const action = typeof args.action === "string" ? args.action : "";
	const directory = typeof args.directory === "string" ? args.directory : "";
	const ref = typeof args.ref === "string" ? ` ${args.ref}` : "";
	return `${theme.fg("toolTitle", theme.bold("git"))} ${theme.fg("muted", action)} ${theme.fg("accent", directory)}${ref}`;
}

export function formatGitResult(details: GitToolDetails | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!details) return theme.fg("dim", "No result.");
	if (details.action === "status") return formatGitStatusResult(details.summary, expanded, theme);
	if (details.action === "log") return formatGitLogResult(details.entries, expanded, theme);
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
function formatGitDiffResult(result: GitDiffResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result || result.diff.length === 0) return theme.fg("dim", "No differences.");
	const styledLines = renderDiffLines(
		Number.MAX_SAFE_INTEGER,
		result.diff,
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
		truncationWarning: result.truncated ? theme.fg("warning", "(diff output itself was truncated by maxBytes)") : undefined,
	});
	return lines.join("\n");
}
