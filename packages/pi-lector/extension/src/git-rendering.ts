import type { GitDiffResult, GitLogEntry, GitStatusSummary } from "@danypops/lector";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { LectorTheme } from "./lector-tui-theme.ts";

const DEFAULT_VISIBLE_FILES = 20;
const DEFAULT_VISIBLE_COMMITS = 10;
const DEFAULT_VISIBLE_DIFF_LINES = 60;

export function formatGitStatusCall(args: { directory?: unknown }, theme: LectorTheme): string {
	const directory = typeof args.directory === "string" ? args.directory : "";
	return `${theme.fg("toolTitle", theme.bold("git_status"))} ${theme.fg("accent", directory)}`;
}

export function formatGitStatusResult(summary: GitStatusSummary | undefined, expanded: boolean, theme: LectorTheme): string {
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

export function formatGitLogCall(args: { directory?: unknown; maxCount?: unknown }, theme: LectorTheme): string {
	const directory = typeof args.directory === "string" ? args.directory : "";
	return `${theme.fg("toolTitle", theme.bold("git_log"))} ${theme.fg("accent", directory)}`;
}

export function formatGitLogResult(entries: readonly GitLogEntry[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!entries || entries.length === 0) return theme.fg("dim", "No commits found.");
	const displayCount = expanded ? entries.length : Math.min(DEFAULT_VISIBLE_COMMITS, entries.length);
	const lines = entries
		.slice(0, displayCount)
		.map((entry) => `${theme.fg("accent", entry.sha.slice(0, 8))} ${entry.authoredAt} ${entry.authorName} -- ${entry.message}`);
	const remaining = entries.length - displayCount;
	if (remaining > 0) lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	return lines.join("\n");
}

export function formatGitDiffCall(args: { directory?: unknown; ref?: unknown }, theme: LectorTheme): string {
	const directory = typeof args.directory === "string" ? args.directory : "";
	const ref = typeof args.ref === "string" ? ` ${args.ref}` : "";
	return `${theme.fg("toolTitle", theme.bold("git_diff"))} ${theme.fg("accent", directory)}${ref}`;
}

export function formatGitDiffResult(result: GitDiffResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result || result.diff.length === 0) return theme.fg("dim", "No differences.");
	const lines = result.diff.split("\n");
	const displayCount = expanded ? lines.length : Math.min(DEFAULT_VISIBLE_DIFF_LINES, lines.length);
	const shown = lines.slice(0, displayCount).join("\n");
	const remaining = lines.length - displayCount;
	const truncationNote = remaining > 0 ? `\n${theme.fg("dim", `... ${remaining} more lines (${keyHint("app.tools.expand", "to expand")})`)}` : "";
	const boundedNote = result.truncated ? `\n${theme.fg("warning", "(diff output itself was truncated by maxBytes)")}` : "";
	return shown + truncationNote + boundedNote;
}
