import type { SymbolSearchResult, TextSearchResult } from "@danypops/lector";
import { boundModelContentText, DEFAULT_MODEL_CONTENT_BYTES } from "../presentation/model-content.ts";
import type { CrossWorkspaceOutcome } from "./operations.ts";

const MAX_RESULTS_PER_PROJECT = 10;

function appendOutcomeHeader<T>(lines: string[], entry: CrossWorkspaceOutcome<T>): boolean {
	const { outcome } = entry;
	switch (outcome.status) {
		case "ready":
			lines.push(`${entry.directory} -- ready`);
			break;
		case "loading":
			lines.push(`${entry.directory} -- loading: ${outcome.message}`);
			return false;
		case "error":
			lines.push(`${entry.directory} -- error: ${outcome.message}`);
			return false;
		default: {
			const exhaustive: never = outcome;
			throw new Error(`unhandled workspace query outcome: ${JSON.stringify(exhaustive)}`);
		}
	}
	if (entry.collapsedWith.length > 0) lines.push(`  same workspace as: ${entry.collapsedWith.join(", ")}`);
	return true;
}

/** Formats cross-project symbol outcomes with concrete, independently bounded results for model consumption. */
export function formatFindSymbolsAcrossProjectsModelContent(
	results: readonly CrossWorkspaceOutcome<SymbolSearchResult>[],
	maxBytes = DEFAULT_MODEL_CONTENT_BYTES,
): string {
	const lines = ["Find Symbols Across Projects", `projects: ${results.length}`];
	for (const entry of results) {
		if (!appendOutcomeHeader(lines, entry)) continue;
		if (entry.outcome.status !== "ready") continue;
		const { result } = entry.outcome;
		lines.push(`  provenance: ${result.provenance.fidelity} via ${result.provenance.backend}`);
		lines.push(`  upstream truncated: ${result.truncated}`);
		for (const item of result.symbols.slice(0, MAX_RESULTS_PER_PROJECT)) {
			lines.push(`  ${item.kind} ${item.name} -- ${item.location.path}:${item.location.line}:${item.location.character}`);
		}
		if (result.symbols.length > MAX_RESULTS_PER_PROJECT) lines.push(`  ${result.symbols.length - MAX_RESULTS_PER_PROJECT} more symbols omitted`);
		if (result.symbols.length === 0) lines.push("  no symbols matched");
	}
	return boundModelContentText(lines.join("\n"), maxBytes);
}

/** Formats cross-project text outcomes with concrete, independently bounded matches for model consumption. */
export function formatSearchTextAcrossProjectsModelContent(
	results: readonly CrossWorkspaceOutcome<TextSearchResult>[],
	maxBytes = DEFAULT_MODEL_CONTENT_BYTES,
): string {
	const lines = ["Search Code Across Projects", `projects: ${results.length}`];
	for (const entry of results) {
		if (!appendOutcomeHeader(lines, entry)) continue;
		if (entry.outcome.status !== "ready") continue;
		const { result } = entry.outcome;
		if (result.provenance) lines.push(`  provenance: lexical via ${result.provenance.backend} (${result.provenance.indexState})`);
		lines.push(`  upstream truncated: ${result.truncated}`);
		for (const item of result.matches.slice(0, MAX_RESULTS_PER_PROJECT)) {
			const line = item.line.replace(/\n$/, "");
			lines.push(`  ${item.path}:${item.lineNumber}: ${line}${item.lineTruncated ? " (line truncated)" : ""}`);
		}
		if (result.matches.length > MAX_RESULTS_PER_PROJECT) lines.push(`  ${result.matches.length - MAX_RESULTS_PER_PROJECT} more matches omitted`);
		if (result.matches.length === 0) lines.push("  no matches");
	}
	return boundModelContentText(lines.join("\n"), maxBytes);
}
