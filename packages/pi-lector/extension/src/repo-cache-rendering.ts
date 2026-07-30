import type { CachedRepositoryPage, RepoFetchResult } from "@danypops/lector";
import type { LectorTheme } from "./lector-tui-theme.ts";

type RepoCacheAction = "fetch" | "list" | "evict";

export function formatRepoCacheCall(
	action: RepoCacheAction,
	args: { owner?: unknown; repo?: unknown; ref?: unknown; host?: unknown; text?: unknown },
	theme: LectorTheme,
): string {
	const label = theme.fg("toolTitle", theme.bold("repo_cache"));
	if (action === "list") {
		const filter = typeof args.text === "string" && args.text.length > 0 ? args.text : typeof args.repo === "string" ? args.repo : "";
		return `${label} ${theme.fg("accent", "list")}${filter ? ` ${theme.fg("dim", filter)}` : ""}`;
	}
	const host = typeof args.host === "string" && args.host.length > 0 ? args.host : "github.com";
	const owner = typeof args.owner === "string" ? args.owner : "";
	const repo = typeof args.repo === "string" ? args.repo : "";
	const ref = typeof args.ref === "string" ? `@${args.ref}` : "";
	return `${label} ${theme.fg("accent", action)} ${theme.fg("dim", `${host}/${owner}/${repo}${ref}`)}`;
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

export function formatRepoCacheListResult(page: CachedRepositoryPage | undefined, theme: LectorTheme): string {
	const count = page?.entries.length ?? 0;
	return count === 0 ? theme.fg("dim", "no cached repositories") : theme.fg("success", `${count} cached repositor${count === 1 ? "y" : "ies"}`);
}

export function formatRepoCacheEvictResult(result: { evicted: boolean } | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	return result.evicted ? theme.fg("success", "evicted") : theme.fg("dim", "nothing cached for that reference");
}
