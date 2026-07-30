import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeCandidate } from "@danypops/lector";
import type { LectorTheme } from "./lector-tui-theme.ts";

type ExternalSearchAction = "github_repos" | "npm_packages" | "sourcegraph_code";

export function formatExternalSearchCall(action: ExternalSearchAction, args: { query?: unknown }, theme: LectorTheme): string {
	const label = theme.fg("toolTitle", theme.bold("external_search"));
	const query = typeof args.query === "string" ? args.query : "";
	return `${label} ${theme.fg("accent", action)} ${theme.fg("dim", query)}`;
}

export function formatGithubRepoSearchResult(result: GithubRepoSearchResult | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	const count = result.candidates.length;
	const summary = count === 0 ? theme.fg("dim", "no repositories matched") : theme.fg("success", `${count} repositor${count === 1 ? "y" : "ies"}`);
	return result.authenticated ? summary : `${summary} ${theme.fg("warning", "(unauthenticated -- lower rate limit)")}`;
}

export function formatNpmPackageSearchResult(result: { candidates: readonly NpmPackageCandidate[] } | undefined, theme: LectorTheme): string {
	const count = result?.candidates.length ?? 0;
	return count === 0 ? theme.fg("dim", "no packages matched") : theme.fg("success", `${count} package${count === 1 ? "" : "s"}`);
}

export function formatSourcegraphCodeSearchResult(result: { candidates: readonly SourcegraphCodeCandidate[] } | undefined, theme: LectorTheme): string {
	const count = result?.candidates.length ?? 0;
	return count === 0 ? theme.fg("dim", "no code matches") : theme.fg("success", `${count} match${count === 1 ? "" : "es"}`);
}
