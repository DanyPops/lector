import type { LineEditOutcome } from "@danypops/lector";
import type { LectorTheme } from "./lector-tui-theme.ts";

export function formatLineEditCall(args: { path?: unknown; edits?: unknown }, theme: LectorTheme): string {
	const path = typeof args.path === "string" ? args.path : "";
	const count = Array.isArray(args.edits) ? args.edits.length : 0;
	return `${theme.fg("toolTitle", theme.bold("line_edit"))} ${theme.fg("accent", path)} ${theme.fg("dim", `(${count} edit${count === 1 ? "" : "s"})`)}`;
}

export function formatLineEditResult(result: LineEditOutcome | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	return theme.fg("accent", `${result.path}: ${result.previousHash} -> ${result.newHash}`);
}
