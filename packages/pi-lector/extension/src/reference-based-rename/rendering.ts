import type { OperationOutputs } from "@danypops/lector";
import type { LectorTheme } from "../lector-tui-theme.ts";

export type ReferenceBasedRenameOutcome = OperationOutputs["workspace.referenceBasedRename"];

/** Formats a successful reference-based rename with every fact required for guarded transaction revert. */
export function formatReferenceBasedRenameModelContent(outcome: ReferenceBasedRenameOutcome): string {
	return [
		`moved to ${outcome.movedTo}`,
		outcome.filesUpdated.length === 0
			? "no other files referenced it"
			: `updated imports in ${outcome.filesUpdated.length} file(s): ${outcome.filesUpdated.join(", ")}`,
		`transaction ${outcome.transactionId}`,
		...outcome.caveats.map((caveat) => `caveat: ${caveat}`),
	].join("\n");
}

/** Formats the compact human mutation result while preserving its reusable transaction identity. */
export function formatReferenceBasedRenameResult(outcome: ReferenceBasedRenameOutcome, theme: LectorTheme): string {
	return `${theme.fg("success", "moved")} ${theme.fg("accent", outcome.movedTo)} ${theme.fg("dim", `(${outcome.filesUpdated.length} import(s) updated, transaction ${outcome.transactionId})`)}`;
}
