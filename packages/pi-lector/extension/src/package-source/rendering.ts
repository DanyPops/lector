import type { PackageSourceListEntry, PackageSourceOperationResult } from "@danypops/lector";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { renderTruncatedList, type TableColumn } from "malevich-tui-components";
import type { LectorTheme } from "../lector-tui-theme.ts";

const DEFAULT_VISIBLE_CANDIDATES = 5;

/** Table has no row-count bound of its own; the underlying index can grow arbitrarily large even though package.listSources's own maxResults bounds any one page. Mirrors REPO_CACHE_VISIBLE_ROWS. */
export const PACKAGE_SOURCE_LIST_VISIBLE_ROWS = 20;

type PackageSourceAction = "resolve" | "list" | "remove" | "clean";

export function formatPackageSourceCall(
	args: { action?: unknown; directory?: unknown; name?: unknown; version?: unknown; ecosystem?: unknown; resolvedVersion?: unknown; text?: unknown },
	theme: LectorTheme,
): string {
	const label = theme.fg("toolTitle", theme.bold("package_source"));
	const action: PackageSourceAction = args.action === "list" || args.action === "remove" || args.action === "clean" ? args.action : "resolve";
	if (action === "list") {
		const text = typeof args.text === "string" && args.text.length > 0 ? ` ${theme.fg("dim", args.text)}` : "";
		return `${label} ${theme.fg("accent", "list")}${text}`;
	}
	if (action === "remove" || action === "clean") {
		const name = typeof args.name === "string" ? args.name : "";
		const version = typeof args.resolvedVersion === "string" ? `@${args.resolvedVersion}` : "";
		const ecosystem = typeof args.ecosystem === "string" ? args.ecosystem : "";
		const identity = name ? `${name}${version}` : ecosystem;
		return `${label} ${theme.fg("accent", action)}${identity ? ` ${theme.fg("dim", identity)}` : ""}`;
	}
	const name = typeof args.name === "string" ? args.name : "";
	const version = typeof args.version === "string" ? `@${args.version}` : "";
	const directory = typeof args.directory === "string" ? args.directory : "";
	return `${label} ${theme.fg("accent", `${name}${version}`)} ${theme.fg("dim", directory)}`.trim();
}

export function formatPackageSourceResult(result: PackageSourceOperationResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No package-source result.");
	const { outcome } = result;
	if (outcome.status === "verified") {
		return [
			`${theme.fg("accent", result.workspaceId ?? "unregistered")} ${theme.fg("success", `${outcome.coordinate.name}@${outcome.coordinate.resolvedVersion}`)}`,
			`${outcome.workspace.cachePath}`,
			`${outcome.repository.url ?? "local source"}@${outcome.repository.resolvedRef ?? "local"} ${outcome.repository.commit ?? outcome.verification.integrity}`,
		].join("\n");
	}
	if (outcome.status === "ambiguous") {
		const lines = [
			theme.fg("warning", `Ambiguous package source (${outcome.code})`),
			...renderTruncatedList({
				items: outcome.candidates,
				expanded,
				visibleCount: DEFAULT_VISIBLE_CANDIDATES,
				formatItem: (candidate) => `${candidate.version} -- ${candidate.source}`,
				moreLine: (hidden) => theme.fg("dim", `… ${hidden} more`),
				truncationWarning: outcome.truncated ? theme.fg("dim", "More candidates were truncated by the daemon.") : undefined,
			}),
		];
		return lines.join("\n");
	}
	if (outcome.status === "unauthenticated") {
		return theme.fg("warning", `Authentication required (${outcome.code}): configure ${outcome.requiredCredentialNames.join(", ")}`);
	}
	if (outcome.status === "oversized") return theme.fg("warning", `Source resolution exceeded ${outcome.resource} limit ${outcome.limit}.`);
	if (outcome.status === "mismatched") return theme.fg("error", `Source mismatch (${outcome.code}): expected ${outcome.expected}, got ${outcome.actual}.`);
	return theme.fg("warning", `Source unavailable (${outcome.code}).`);
}

/** Empty-state fallback only -- a non-empty page renders as a real Table (see buildPackageSourceListTableRows) so the human channel actually shows what's resolved, not just a bare count. Mirrors formatRepoCacheListResult. */
export function formatPackageSourceListResult(
	page: { entries: readonly PackageSourceListEntry[]; nextCursor?: string | null } | undefined,
	theme: LectorTheme,
): string {
	const count = page?.entries.length ?? 0;
	return count === 0 ? theme.fg("dim", "no resolved package sources") : theme.fg("success", `${count} resolved package source${count === 1 ? "" : "s"}`);
}

/** Powers of 1024, one decimal past the first. Mirrors repo-cache/rendering.ts's own formatCacheSize -- kept as a small local duplicate rather than a shared export, matching that file's own precedent. */
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

export function buildPackageSourceListTableRows(entries: readonly PackageSourceListEntry[]): Record<string, string>[] {
	return entries.map((entry) => ({
		package: `${entry.name}@${entry.resolvedVersion}`,
		workspace: entry.workspaceId,
		path: entry.cachePath,
		size: entry.cacheSizeBytes === null ? "unknown" : formatCacheSize(entry.cacheSizeBytes),
	}));
}

export const PACKAGE_SOURCE_LIST_TABLE_COLUMNS: TableColumn[] = [
	{ header: "Package", key: "package" },
	{ header: "Workspace", key: "workspace" },
	{ header: "Path", key: "path" },
	{ header: "Size", key: "size" },
];

export function packageSourceListMoreLine(theme: LectorTheme): (hiddenCount: number) => string {
	return (hiddenCount) => theme.fg("dim", `... ${hiddenCount} more (${keyHint("app.tools.expand", "to expand")})`);
}

export function formatPackageSourceRemoveResult(result: { removed: boolean } | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	return result.removed ? theme.fg("success", "removed") : theme.fg("dim", "not recorded for that coordinate");
}

export function formatPackageSourceCleanResult(result: { removed: number; skipped: number } | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	return theme.fg("success", `removed ${result.removed}, skipped ${result.skipped} (still in use)`);
}
