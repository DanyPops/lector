import type { PackageSourceOperationResult } from "@danypops/lector";
import { renderTruncatedList } from "malevich-tui-components";
import type { LectorTheme } from "./lector-tui-theme.ts";

const DEFAULT_VISIBLE_CANDIDATES = 5;

export function formatPackageSourceCall(args: { directory?: unknown; name?: unknown; version?: unknown }, theme: LectorTheme): string {
	const name = typeof args.name === "string" ? args.name : "";
	const version = typeof args.version === "string" ? `@${args.version}` : "";
	const directory = typeof args.directory === "string" ? args.directory : "";
	return `${theme.fg("toolTitle", theme.bold("package_source"))} ${theme.fg("accent", `${name}${version}`)} ${theme.fg("dim", directory)}`.trim();
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
