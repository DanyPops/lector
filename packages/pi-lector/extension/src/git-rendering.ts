import type { GitDiffResult, GitLogEntry, GitStatusSummary } from "@danypops/lector";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { LectorTheme } from "./lector-tui-theme.ts";

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

function formatGitStatusResult(summary: GitStatusSummary | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!summary) return theme.fg("dim", "No status available.");
	const branch = summary.current ?? "(detached)";
	const tracking = summary.tracking ? `, tracking ${summary.tracking} (+${summary.ahead}/-${summary.behind})` : "";
	const lines = [theme.fg("accent", `On branch ${branch}${tracking}`)];
	if (summary.files.length === 0) {
		lines.push(theme.fg("dim", "working tree clean"));
		return lines.join("\n");
	}
	const displayCount = expanded ? summary.files.length : Math.min(DEFAULT_VISIBLE_FILES, summary.files.length);
	for (const file of summary.files.slice(0, displayCount)) {
		const code = `${file.indexStatus}${file.workingDirStatus}`;
		lines.push(file.renamedFrom ? `${code} ${file.renamedFrom} -> ${file.path}` : `${code} ${file.path}`);
	}
	const remaining = summary.files.length - displayCount;
	if (remaining > 0) lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	return lines.join("\n");
}

function formatGitLogResult(entries: readonly GitLogEntry[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!entries || entries.length === 0) return theme.fg("dim", "No commits found.");
	const displayCount = expanded ? entries.length : Math.min(DEFAULT_VISIBLE_COMMITS, entries.length);
	const lines = entries
		.slice(0, displayCount)
		.map((entry) => `${theme.fg("accent", entry.sha.slice(0, 8))} ${entry.authoredAt} ${entry.authorName} -- ${entry.message}`);
	const remaining = entries.length - displayCount;
	if (remaining > 0) lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	return lines.join("\n");
}

function formatGitDiffResult(result: GitDiffResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result || result.diff.length === 0) return theme.fg("dim", "No differences.");
	const lines = result.diff.split("\n");
	const displayCount = expanded ? lines.length : Math.min(DEFAULT_VISIBLE_DIFF_LINES, lines.length);
	const shown = lines.slice(0, displayCount).join("\n");
	const remaining = lines.length - displayCount;
	const truncationNote = remaining > 0 ? `\n${theme.fg("dim", `... ${remaining} more lines (${keyHint("app.tools.expand", "to expand")})`)}` : "";
	const boundedNote = result.truncated ? `\n${theme.fg("warning", "(diff output itself was truncated by maxBytes)")}` : "";
	return shown + truncationNote + boundedNote;
}
