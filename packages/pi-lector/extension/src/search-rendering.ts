import type { TextSearchResult } from "@danypops/lector";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { LectorTheme } from "./lector-tui-theme.ts";

const DEFAULT_VISIBLE_MATCHES = 20;

export function formatSearchCall(args: { directory?: unknown; query?: unknown }, theme: LectorTheme): string {
	const directory = typeof args.directory === "string" ? args.directory : "";
	const query = typeof args.query === "string" ? args.query : "";
	return `${theme.fg("toolTitle", theme.bold("search_code"))} ${theme.fg("accent", `"${query}"`)} ${theme.fg("dim", directory)}`;
}

export function formatSearchResult(result: TextSearchResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result || result.matches.length === 0) return theme.fg("dim", "No matches found.");
	const displayCount = expanded ? result.matches.length : Math.min(DEFAULT_VISIBLE_MATCHES, result.matches.length);
	const lines = result.matches.slice(0, displayCount).map((match) => `${theme.fg("accent", match.path)}:${match.lineNumber}: ${match.line.replace(/\n$/, "")}`);
	const remaining = result.matches.length - displayCount;
	if (remaining > 0) lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	if (result.truncated) lines.push(theme.fg("warning", "(search itself was truncated by maxMatches/maxBytes -- results are incomplete)"));
	return lines.join("\n");
}
