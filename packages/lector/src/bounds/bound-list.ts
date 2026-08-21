/**
 * Bounded offset pagination over one already-in-memory array, stopping at maxResults and
 * skipping byte-oversized items while continuing to scan for later compact entries -- shared by every code-intelligence/cache-detail operation
 * that returns a list a real workspace can make arbitrarily large (locations, symbols,
 * diagnostics, calls, walked files, failures). `truncated` is honest about either bound cutting
 * the page short, never just "more pages exist" (offset+items.length < totalCount already
 * answers that separately). `nextOffset` is the source-array cursor after every inspected item,
 * including an omitted oversized one, so real pagination never duplicates a compact item that
 * followed an omission. Most callers pass offset 0; workspace.cacheWalkedFiles and
 * workspace.cacheFailures expose nextOffset for real paging.
 */
export function boundList<T>(
	items: readonly T[],
	offset: number,
	maxResults: number,
	maxBytes: number,
	sizeOf: (item: T) => number,
): { readonly page: readonly T[]; readonly totalCount: number; readonly nextOffset: number; readonly truncated: boolean } {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative safe integer");
	if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new RangeError("maxResults must be a positive safe integer");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
	const page: T[] = [];
	let bytes = 0;
	let nextOffset = Math.min(offset, items.length);
	let truncated = false;
	for (let index = offset; index < items.length; index++) {
		if (page.length >= maxResults) {
			truncated = true;
			break;
		}
		nextOffset = index + 1;
		const item = items[index];
		if (item === undefined) continue;
		const itemBytes = sizeOf(item);
		if (bytes + itemBytes > maxBytes) {
			// An oversized item must not consume the entire response or prevent a later,
			// compact item from being returned. DTO-specific callers that can safely
			// preserve identity while truncating content should do so before this generic
			// list bound; arbitrary objects are omitted rather than silently mutilated.
			truncated = true;
			continue;
		}
		page.push(item);
		bytes += itemBytes;
	}
	return { page, totalCount: items.length, nextOffset, truncated: truncated || nextOffset < items.length };
}

/** A reasonable default sizeOf for boundList/boundListFromStart over small heterogeneous objects (locations, symbols, diagnostics, calls) -- exact JSON-encoded byte size, not an approximation, at the cost of one stringify per item. */
export function jsonByteSize(item: unknown): number {
	return Buffer.byteLength(JSON.stringify(item), "utf8");
}

/** boundList with offset fixed at 0 -- the common case of "give me one bounded page, not real pagination". */
export function boundListFromStart<T>(
	items: readonly T[],
	maxResults: number,
	maxBytes: number,
	sizeOf: (item: T) => number,
): { readonly page: readonly T[]; readonly totalCount: number; readonly nextOffset: number; readonly truncated: boolean } {
	return boundList(items, 0, maxResults, maxBytes, sizeOf);
}
