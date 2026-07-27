import type { FindFilesResult } from "@danypops/lector";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { LectorTheme } from "./lector-tui-theme.ts";

const DEFAULT_VISIBLE_PATHS = 40;

export function formatFindFilesCall(args: { directory?: unknown; patterns?: unknown }, theme: LectorTheme): string {
	const directory = typeof args.directory === "string" ? args.directory : "";
	const patterns = Array.isArray(args.patterns) ? args.patterns.filter((p): p is string => typeof p === "string") : [];
	return `${theme.fg("toolTitle", theme.bold("find_files"))} ${theme.fg("accent", patterns.map((p) => `"${p}"`).join(", "))} ${theme.fg("dim", directory)}`;
}

export function formatFindFilesResult(result: FindFilesResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result || result.paths.length === 0) return theme.fg("dim", "No files found.");
	const displayCount = expanded ? result.paths.length : Math.min(DEFAULT_VISIBLE_PATHS, result.paths.length);
	const lines = result.paths.slice(0, displayCount).map((path) => theme.fg("accent", path));
	const remaining = result.paths.length - displayCount;
	if (remaining > 0) lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	if (result.truncated) lines.push(theme.fg("warning", "(listing itself was truncated by maxResults/maxBytes -- results are incomplete)"));
	return lines.join("\n");
}
