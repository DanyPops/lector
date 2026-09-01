import type { EditOutcome } from "@danypops/lector";
import { renderDiffLines, renderTruncatedList, type TextMeasure } from "malevich-tui-components";
import type { LectorTheme } from "../lector-tui-theme.ts";
import { presentationTitle } from "../presentation/tool-presentation.ts";

/**
 * The applied result (EditOutcome) only carries a hash transition, not the
 * diff text itself -- the model already has what it submitted, so there's
 * nothing to render as a Diff on the result side. The call's own patchText
 * argument is the real diff content, so the colored preview lives here
 * instead of formatApplyPatchResult, unlike git_diff's coloring (which
 * lives on the result side because that's where GitDiffResult's diff text
 * actually is).
 */
const DEFAULT_VISIBLE_PATCH_LINES = 12;

export function formatApplyPatchCall(args: { path?: unknown; patchText?: unknown }, theme: LectorTheme, measure?: TextMeasure): string {
	const path = typeof args.path === "string" ? args.path : "";
	const header = `${theme.fg("toolTitle", theme.bold(presentationTitle("apply_patch")))} ${theme.fg("accent", path)}`;
	if (typeof args.patchText !== "string" || args.patchText.length === 0) return header;

	const styledLines = renderDiffLines(
		Number.MAX_SAFE_INTEGER,
		args.patchText,
		{
			add: (s) => theme.fg("success", s),
			remove: (s) => theme.fg("error", s),
			context: (s) => theme.fg("dim", s),
			hunk: (s) => theme.fg("accent", s),
			header: (s) => theme.fg("muted", s),
		},
		measure,
	);
	// No expand affordance here -- renderCall has no `expanded` option (that's
	// renderResult-only), so a call-time preview is always just a hard cap,
	// never an "expand to see more" invitation the call slot can't honor.
	const preview = renderTruncatedList({
		items: styledLines,
		expanded: false,
		visibleCount: DEFAULT_VISIBLE_PATCH_LINES,
		formatItem: (line) => line,
		moreLine: (hidden) => theme.fg("dim", `... ${hidden} more line${hidden === 1 ? "" : "s"}`),
	});
	return [header, ...preview].join("\n");
}

export function formatApplyPatchResult(result: EditOutcome | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No result.");
	return theme.fg("accent", `${result.path}: ${result.previousHash ?? "(new)"} -> ${result.newHash}`);
}
