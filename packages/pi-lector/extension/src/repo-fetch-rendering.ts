import type { RepoFetchResult } from "@danypops/lector";
import type { LectorTheme } from "./lector-tui-theme.ts";

export function formatRepoFetchCall(args: { owner?: unknown; repo?: unknown; ref?: unknown; host?: unknown }, theme: LectorTheme): string {
	const host = typeof args.host === "string" && args.host.length > 0 ? args.host : "github.com";
	const owner = typeof args.owner === "string" ? args.owner : "";
	const repo = typeof args.repo === "string" ? args.repo : "";
	const ref = typeof args.ref === "string" ? `@${args.ref}` : "";
	return `${theme.fg("toolTitle", theme.bold("repo_fetch"))} ${theme.fg("accent", `${host}/${owner}/${repo}${ref}`)}`;
}

export function formatRepoFetchResult(result: (RepoFetchResult & { workspaceId: string }) | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	const lines = [
		`${theme.fg("accent", result.workspaceId)} ${result.fromCache ? theme.fg("dim", "(from cache)") : theme.fg("toolTitle", "(fetched)")} -- ${result.path}`,
	];
	if (result.refFallbackOccurred) {
		lines.push(theme.fg("warning", `requested ref not found; fell back to the default branch (resolved: ${result.resolvedRef})`));
	}
	return lines.join("\n");
}
