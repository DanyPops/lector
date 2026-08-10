import { boundListFromStart, jsonByteSize } from "../bounds/bound-list.ts";
import { truncateUtf8 } from "../bounds/truncate-utf8.ts";
import type { MutationHistoryEntry } from "./mutation-history.ts";

/** A listed entry's own stored beforeContent, capped independently of the list's total byte budget. */
export interface BoundedMutationHistoryEntry extends Omit<MutationHistoryEntry, "beforeContent"> {
	readonly beforeContent: string | null;
	readonly beforeContentTruncated: boolean;
}

export interface BoundMutationHistoryEntriesResult {
	readonly entries: readonly BoundedMutationHistoryEntry[];
	readonly truncated: boolean;
}

/**
 * Two-stage bounding for a real list of stored file snapshots: first caps each entry's own
 * beforeContent to maxEntryContentBytes -- one giant file's history must not exhaust the whole
 * response budget by itself -- then bounds the resulting list by count and total serialized
 * bytes, same discipline workspace.cacheWalkedFiles/cacheFailures already use for their own
 * stored strings. Internal revert reads go through the store directly and never see this
 * truncation -- a revert always needs the exact, untruncated beforeContent to be correct.
 */
export function boundMutationHistoryEntries(
	entries: readonly MutationHistoryEntry[],
	maxResults: number,
	maxBytes: number,
	maxEntryContentBytes: number,
): BoundMutationHistoryEntriesResult {
	const capped: BoundedMutationHistoryEntry[] = entries.map((entry) => {
		if (entry.beforeContent === null) return { ...entry, beforeContent: null, beforeContentTruncated: false };
		const bounded = truncateUtf8(entry.beforeContent, maxEntryContentBytes);
		return { ...entry, beforeContent: bounded.value, beforeContentTruncated: bounded.truncated };
	});
	const page = boundListFromStart(capped, maxResults, maxBytes, jsonByteSize);
	return { entries: page.page, truncated: page.truncated };
}
