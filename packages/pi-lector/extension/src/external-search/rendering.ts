import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeCandidate } from "@danypops/lector";
import type { LectorTheme } from "../lector-tui-theme.ts";
import { presentationTitle } from "../presentation/tool-presentation.ts";

type ExternalSearchAction = "github_repos" | "npm_packages" | "sourcegraph_code";

export function formatExternalSearchCall(action: ExternalSearchAction, args: { query?: unknown }, theme: LectorTheme): string {
	const label = theme.fg("toolTitle", theme.bold(presentationTitle("external_search", action)));
	const query = typeof args.query === "string" ? args.query : "";
	return `${label} ${theme.fg("accent", `"${query}"`)}`;
}

const VISIBLE_CANDIDATES = 8;

function boundedCandidates<T>(candidates: readonly T[], expanded: boolean): { visible: readonly T[]; more: number } {
	const visible = expanded ? candidates : candidates.slice(0, VISIBLE_CANDIDATES);
	return { visible, more: candidates.length - visible.length };
}

export function formatGithubRepoSearchResult(result: GithubRepoSearchResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	if (result.candidates.length === 0) return theme.fg("dim", "no repositories matched");
	const { visible, more } = boundedCandidates(result.candidates, expanded);
	const lines = visible.map(
		(candidate) =>
			`${theme.fg("accent", `${candidate.host}/${candidate.owner}/${candidate.repo}`)} · ${candidate.stars} stars${candidate.language ? ` · ${candidate.language}` : ""}${candidate.description ? `\n  ${candidate.description}` : ""}`,
	);
	if (more > 0) lines.push(theme.fg("muted", `… ${more} more (expand to show)`));
	if (!result.authenticated) lines.push(theme.fg("warning", "unauthenticated -- lower rate limit"));
	return lines.join("\n");
}

export function formatNpmPackageSearchResult(
	result: { candidates: readonly NpmPackageCandidate[] } | undefined,
	expanded: boolean,
	theme: LectorTheme,
): string {
	if (!result || result.candidates.length === 0) return theme.fg("dim", "no packages matched");
	const { visible, more } = boundedCandidates(result.candidates, expanded);
	const lines = visible.map(
		(candidate) =>
			`${theme.fg("accent", `${candidate.name}@${candidate.version}`)} · score ${candidate.score.toFixed(3)}${candidate.description ? `\n  ${candidate.description}` : ""}`,
	);
	if (more > 0) lines.push(theme.fg("muted", `… ${more} more (expand to show)`));
	return lines.join("\n");
}

export function formatSourcegraphCodeSearchResult(
	result: { candidates: readonly SourcegraphCodeCandidate[] } | undefined,
	expanded: boolean,
	theme: LectorTheme,
): string {
	if (!result || result.candidates.length === 0) return theme.fg("dim", "no code matches");
	const { visible, more } = boundedCandidates(result.candidates, expanded);
	const lines = visible.map((candidate) => {
		const matches = candidate.lineMatches.slice(0, expanded ? candidate.lineMatches.length : 3);
		return `${theme.fg("accent", `${candidate.repository}/${candidate.path}`)}\n${matches.map((match) => `  ${match.line}: ${match.preview}`).join("\n")}`;
	});
	if (more > 0) lines.push(theme.fg("muted", `… ${more} more (expand to show)`));
	return lines.join("\n");
}
