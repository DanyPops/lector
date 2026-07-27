import type { EditOutcome } from "@danypops/lector";
import type { LectorTheme } from "./lector-tui-theme.ts";

export function formatApplyPatchCall(args: { path?: unknown }, theme: LectorTheme): string {
	const path = typeof args.path === "string" ? args.path : "";
	return `${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("accent", path)}`;
}

export function formatApplyPatchResult(result: EditOutcome | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	return theme.fg("accent", `${result.path}: ${result.previousHash ?? "(new)"} -> ${result.newHash}`);
}
