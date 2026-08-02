import type { CachedRepositoryEntry, CachedRepositoryPage, RepoFetchResult } from "@danypops/lector";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { TableColumn } from "malevich-tui-components";
import type { LectorTheme } from "../lector-tui-theme.ts";

/** Table has no row-count bound of its own; a cache can grow arbitrarily large even though repo_cache's own `maxResults` bounds any one page, so the display itself still needs a cap independent of that. */
export const REPO_CACHE_VISIBLE_ROWS = 20;

export function repoCacheMoreLine(theme: LectorTheme): (hiddenCount: number) => string {
	return (hiddenCount) => theme.fg("dim", `... ${hiddenCount} more (${keyHint("app.tools.expand", "to expand")})`);
}

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

/** Empty-state fallback only -- a non-empty page renders as a real Table (see REPO_CACHE_TABLE_COLUMNS/buildRepoCacheTableRows) so the human channel actually shows what's cached, not just a bare count. */
export function formatRepoCacheListResult(page: CachedRepositoryPage | undefined, theme: LectorTheme): string {
	const count = page?.entries.length ?? 0;
	return count === 0 ? theme.fg("dim", "no cached repositories") : theme.fg("success", `${count} cached repositor${count === 1 ? "y" : "ies"}`);
}

export const REPO_CACHE_TABLE_COLUMNS: TableColumn[] = [
	{ header: "Repository", key: "repo" },
	{ header: "Ref", key: "ref" },
	{ header: "Registered", key: "registered" },
	{ header: "Size", key: "size" },
	{ header: "Fetched", key: "fetched" },
];

/** Powers of 1024, one decimal past the first -- "cache size" is always at least a git checkout, so bytes/KB granularity is never useful here. */
function formatCacheSize(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"] as const;
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${unitIndex === 0 ? value : value.toFixed(1)} ${units[unitIndex]}`;
}

export function buildRepoCacheTableRows(entries: readonly CachedRepositoryEntry[]): Record<string, string>[] {
	return entries.map((entry) => ({
		repo: `${entry.host}/${entry.owner}/${entry.repo}`,
		ref: entry.requestedRef === entry.resolvedRef ? entry.resolvedRef : `${entry.requestedRef} -> ${entry.resolvedRef}`,
		registered: entry.registeredWorkspaceId ?? "no",
		size: formatCacheSize(entry.cacheSizeBytes),
		fetched: new Date(entry.fetchedAt).toISOString(),
	}));
}

export function formatRepoCacheEvictResult(result: { evicted: boolean } | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	return result.evicted ? theme.fg("success", "evicted") : theme.fg("dim", "nothing cached for that reference");
}
