/**
 * Bounded offset pagination over one already-in-memory array, stopping at whichever of
 * maxResults/maxBytes is hit first -- shared by workspace.cacheWalkedFiles and
 * workspace.cacheFailures, the two "give me the full raw detail" operations a compact
 * cacheStatus summary deliberately no longer inlines. `truncated` is honest about either
 * bound cutting the page short, never just "more pages exist" (offset+items.length < totalCount
 * already answers that separately).
 */
export function paginateWithByteBudget<T>(
	items: readonly T[],
	offset: number,
	maxResults: number,
	maxBytes: number,
	sizeOf: (item: T) => number,
): { readonly page: readonly T[]; readonly totalCount: number; readonly truncated: boolean } {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative safe integer");
	if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new RangeError("maxResults must be a positive safe integer");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
	const page: T[] = [];
	let bytes = 0;
	let truncated = false;
	for (let index = offset; index < items.length; index++) {
		if (page.length >= maxResults) {
			truncated = true;
			break;
		}
		const item = items[index];
		if (item === undefined) continue;
		const itemBytes = sizeOf(item);
		if (page.length > 0 && bytes + itemBytes > maxBytes) {
			truncated = true;
			break;
		}
		page.push(item);
		bytes += itemBytes;
	}
	return { page, totalCount: items.length, truncated: truncated || offset + page.length < items.length };
}
