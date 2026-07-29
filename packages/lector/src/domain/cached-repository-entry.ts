/** One repository currently present in RepoFetcherPort's on-disk cache, exactly as fetched -- no network or mutation involved in producing this. Port-level shape; has no notion of workspace registration (that's a service-layer concern, added separately -- see CachedRepositoryEntry). */
export interface RepoCacheListEntry {
	readonly host: string;
	readonly owner: string;
	readonly repo: string;
	/** The ref segment the cache was keyed under at fetch time -- "HEAD" means "the remote's default branch was requested", not literally the ref named "HEAD". */
	readonly requestedRef: string;
	/** The ref actually checked out -- may differ from requestedRef if it didn't exist and cloning fell back to the default branch. */
	readonly resolvedRef: string;
	readonly commit: string;
	readonly path: string;
	readonly cacheSizeBytes: number;
	readonly fetchedAt: number;
}

/** A RepoCacheListEntry enriched with whether it's currently a registered workspace -- the shape queryCachedRepositories operates over. */
export interface CachedRepositoryEntry extends RepoCacheListEntry {
	/** The workspace id this entry is currently registered under, or null if it exists on disk but isn't (or is no longer) a registered workspace. */
	readonly registeredWorkspaceId: string | null;
}

export interface CachedRepositoryQuery {
	/** Case-insensitive substring match across host/owner/repo/requestedRef/resolvedRef. */
	readonly text?: string;
	readonly host?: string;
	readonly owner?: string;
	readonly repo?: string;
	/** Matches either requestedRef or resolvedRef. */
	readonly ref?: string;
}

export interface CachedRepositoryPage {
	readonly entries: readonly CachedRepositoryEntry[];
	/** Opaque -- pass back verbatim as the next call's cursor. Null means no further entries. */
	readonly nextCursor: string | null;
}

function identityKey(entry: CachedRepositoryEntry): string {
	return `${entry.host}/${entry.owner}/${entry.repo}/${entry.requestedRef}`;
}

function matches(entry: CachedRepositoryEntry, query: CachedRepositoryQuery): boolean {
	if (query.host !== undefined && entry.host !== query.host) return false;
	if (query.owner !== undefined && entry.owner !== query.owner) return false;
	if (query.repo !== undefined && entry.repo !== query.repo) return false;
	if (query.ref !== undefined && entry.requestedRef !== query.ref && entry.resolvedRef !== query.ref) return false;
	if (query.text !== undefined) {
		const needle = query.text.toLowerCase();
		const haystack = `${entry.host} ${entry.owner} ${entry.repo} ${entry.requestedRef} ${entry.resolvedRef}`.toLowerCase();
		if (!haystack.includes(needle)) return false;
	}
	return true;
}

/**
 * Filters and paginates a RepoFetcherPort cache listing -- pure, no I/O. Sorted by canonical
 * identity (host/owner/repo/requestedRef), not fetch time or LRU recency, so a cursor stays
 * meaningful across calls even if the underlying cache is touched by a concurrent fetch between
 * pages. The cursor is the last-returned entry's own identity key; the next page starts strictly
 * after it in sorted order -- robust to insertions/deletions elsewhere in the set, unlike an
 * offset.
 */
export function queryCachedRepositories(
	allEntries: readonly CachedRepositoryEntry[],
	query: CachedRepositoryQuery,
	maxResults: number,
	cursor?: string,
): CachedRepositoryPage {
	if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new TypeError("maxResults must be a positive safe integer");

	const sorted = allEntries.filter((entry) => matches(entry, query)).sort((a, b) => identityKey(a).localeCompare(identityKey(b)));

	const startIndex = cursor === undefined ? 0 : sorted.findIndex((entry) => identityKey(entry) > cursor);
	const remaining = startIndex === -1 ? [] : sorted.slice(startIndex);

	const page = remaining.slice(0, maxResults);
	const lastOfPage = page.at(-1);
	const nextCursor = remaining.length > maxResults && lastOfPage ? identityKey(lastOfPage) : null;
	return { entries: page, nextCursor };
}
