import type { SymbolSearchResult, TextSearchResult } from "@danypops/lector";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { renderTruncatedList } from "malevich-tui-components";
import { describeFindSymbolSources } from "../find-symbols/rendering.ts";
import type { LectorTheme } from "../lector-tui-theme.ts";
import type { CrossWorkspaceOutcome } from "./operations.ts";

const DEFAULT_VISIBLE_PER_WORKSPACE = 10;

export function formatCrossWorkspaceCall(args: { directories?: unknown; query?: unknown }, theme: LectorTheme): string {
	const directories = Array.isArray(args.directories) ? args.directories.filter((d): d is string => typeof d === "string") : [];
	const query = typeof args.query === "string" ? args.query : "";
	return `${theme.fg("accent", `"${query}"`)} ${theme.fg("dim", `across ${directories.length} project(s)`)}`;
}

function formatOutcomeHeader(entry: CrossWorkspaceOutcome<unknown>, theme: LectorTheme): string {
	const { outcome } = entry;
	const label = theme.fg("accent", entry.directory);
	const lines: string[] = [];
	switch (outcome.status) {
		case "ready":
			lines.push(label);
			break;
		case "loading":
			lines.push(`${label} ${theme.fg("warning", `-- still loading: ${outcome.message}`)}`);
			break;
		case "error":
			lines.push(`${label} ${theme.fg("error", `-- ${outcome.message}`)}`);
			break;
		default: {
			const exhaustive: never = outcome;
			throw new Error(`unhandled workspace query outcome status: ${JSON.stringify(exhaustive)}`);
		}
	}
	// Surfaced explicitly, never silently -- two distinct inputs resolving to one workspace means
	// one of their own result payloads below is a real duplicate of the other's, not two independent answers.
	if (entry.collapsedWith.length > 0) {
		lines.push(theme.fg("warning", `  resolved to the same workspace as: ${entry.collapsedWith.join(", ")}`));
	}
	return lines.join("\n");
}

export function formatFindSymbolsAcrossProjectsResult(
	results: readonly CrossWorkspaceOutcome<SymbolSearchResult>[] | undefined,
	expanded: boolean,
	theme: LectorTheme,
): string {
	if (!results || results.length === 0) return theme.fg("dim", "No projects to search.");
	const lines: string[] = [];
	for (const entry of results) {
		lines.push(formatOutcomeHeader(entry, theme));
		const { outcome } = entry;
		if (outcome.status !== "ready") continue;
		lines.push(
			theme.fg("muted", `  ${outcome.result.provenance.fidelity} via ${outcome.result.provenance.backend}${outcome.result.truncated ? " (truncated)" : ""}`),
		);
		for (const source of describeFindSymbolSources(outcome.result)) lines.push(theme.fg("muted", `  ${source}`));
		if (outcome.result.symbols.length === 0) {
			lines.push(theme.fg("dim", "  no symbols matched"));
			continue;
		}
		lines.push(
			...renderTruncatedList({
				items: outcome.result.symbols,
				expanded,
				visibleCount: DEFAULT_VISIBLE_PER_WORKSPACE,
				formatItem: (symbol) => `  ${symbol.kind} ${symbol.name} -- ${symbol.location.path}:${symbol.location.line}:${symbol.location.character}`,
				moreLine: (hidden) => theme.fg("dim", `  ... ${hidden} more (${keyHint("app.tools.expand", "to expand")})`),
			}),
		);
	}
	return lines.join("\n");
}

export function formatSearchTextAcrossProjectsResult(
	results: readonly CrossWorkspaceOutcome<TextSearchResult>[] | undefined,
	expanded: boolean,
	theme: LectorTheme,
): string {
	if (!results || results.length === 0) return theme.fg("dim", "No projects to search.");
	const lines: string[] = [];
	for (const entry of results) {
		lines.push(formatOutcomeHeader(entry, theme));
		const { outcome } = entry;
		if (outcome.status !== "ready") continue;
		if (outcome.result.matches.length === 0) {
			lines.push(theme.fg("dim", "  no matches"));
			continue;
		}
		lines.push(
			...renderTruncatedList({
				items: outcome.result.matches,
				expanded,
				visibleCount: DEFAULT_VISIBLE_PER_WORKSPACE,
				formatItem: (match) =>
					`  ${match.path}:${match.lineNumber}: ${match.line.replace(/\n$/, "")}${match.lineTruncated ? theme.fg("warning", " (line truncated)") : ""}`,
				moreLine: (hidden) => theme.fg("dim", `  ... ${hidden} more (${keyHint("app.tools.expand", "to expand")})`),
				truncationWarning: outcome.result.truncated
					? theme.fg("warning", "  (this workspace's search was itself truncated by maxMatches/maxBytes)")
					: undefined,
			}),
		);
	}
	return lines.join("\n");
}
