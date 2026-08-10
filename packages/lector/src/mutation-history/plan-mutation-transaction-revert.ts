import type { ContentHash } from "../content-identity/content-hash.ts";
import type { MutationHistoryEntry } from "./mutation-history.ts";
import { canRevertMutation } from "./mutation-history.ts";

export interface TransactionRevertRefused {
	readonly safe: false;
	/** The first entry found stale -- reported, not every one, since refusing on the first is enough to explain the decision and the whole transaction is refused either way. */
	readonly staleEntry: MutationHistoryEntry;
}

export interface TransactionRevertApproved {
	readonly safe: true;
}

export type TransactionRevertPlan = TransactionRevertApproved | TransactionRevertRefused;

/**
 * A rename/multi-file transaction reverts all-or-nothing: every member entry's own target path
 * must still hold exactly what that entry's own mutation produced, or the whole transaction is
 * refused before anything is touched. Never revert half a rename -- an import rewritten back
 * while its declaration stays renamed (or vice versa) is worse than refusing outright, the same
 * CodeScaleBench finding reference-based rename's own pre-flight check already applies.
 */
export function planMutationTransactionRevert(
	entries: readonly MutationHistoryEntry[],
	currentHashes: ReadonlyMap<string, ContentHash | null>,
): TransactionRevertPlan {
	for (const entry of entries) {
		const currentHash = currentHashes.get(entry.path) ?? null;
		if (!canRevertMutation({ entry, currentHash })) return { safe: false, staleEntry: entry };
	}
	return { safe: true };
}
