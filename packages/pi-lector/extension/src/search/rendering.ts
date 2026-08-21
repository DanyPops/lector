import type { TextSearchResult } from "@danypops/lector";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { renderTruncatedList } from "malevich-tui-components";
import type { LectorTheme } from "../lector-tui-theme.ts";

const DEFAULT_VISIBLE_MATCHES = 20;

export function formatSearchCall(args: { directory?: unknown; query?: unknown }, theme: LectorTheme): string {
	const directory = typeof args.directory === "string" ? args.directory : "";
	const query = typeof args.query === "string" ? args.query : "";
	return `${theme.fg("toolTitle", theme.bold("search_code"))} ${theme.fg("accent", `"${query}"`)} ${theme.fg("dim", directory)}`;
}

export function formatSearchResult(result: TextSearchResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result || result.matches.length === 0) return theme.fg("dim", "No matches found.");
	const lines = renderTruncatedList({
		items: result.matches,
		expanded,
		visibleCount: DEFAULT_VISIBLE_MATCHES,
		formatItem: (match) =>
			`${theme.fg("accent", match.path)}:${match.lineNumber}: ${match.line.replace(/\n$/, "")}${match.lineTruncated ? theme.fg("warning", " (line truncated)") : ""}`,
		moreLine: (hidden) => theme.fg("dim", `... ${hidden} more (${keyHint("app.tools.expand", "to expand")})`),
		truncationWarning: result.truncated ? theme.fg("warning", "(search itself was truncated by maxMatches/maxBytes -- results are incomplete)") : undefined,
	});
	return lines.join("\n");
}
