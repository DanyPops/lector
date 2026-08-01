import type { PackageEcosystem, PackageSourceVerificationMethod } from "./package-source.ts";

export interface PackageSourceIndexKey {
	readonly ecosystem: PackageEcosystem;
	readonly registry: string | null;
	readonly name: string;
	readonly resolvedVersion: string;
}

/** One package coordinate this daemon has already resolved to a verified source workspace -- bookkeeping distinct from RepoFetcherPort's own generic (host/owner/repo/ref) disk cache, which has no notion of "this checkout is package X@Y." */
export interface PackageSourceIndexEntry extends PackageSourceIndexKey {
	readonly requestedVersion: string | null;
	readonly repositoryUrl: string | null;
	readonly resolvedRef: string | null;
	readonly commit: string | null;
	readonly cachePath: string;
	readonly workspaceId: string;
	readonly origin: "local" | "fetched";
	readonly verificationMethod: PackageSourceVerificationMethod;
	readonly resolvedAt: number;
}

export interface PackageSourceIndexQuery {
	readonly ecosystem?: PackageEcosystem;
	/** Case-insensitive substring match across ecosystem/name/resolvedVersion. */
	readonly text?: string;
}

export interface PackageSourceIndexPage {
	readonly entries: readonly PackageSourceIndexEntry[];
	/** Opaque -- pass back verbatim as the next call's cursor. Null means no further entries. */
	readonly nextCursor: string | null;
}

/** A PackageSourceIndexEntry enriched with the underlying RepoFetcherPort cache entry's own byte size, when derivable -- the shape package.listSources reports. Mirrors CachedRepositoryEntry extending RepoCacheListEntry: the enrichment is computed at response time, never stored in the index itself. */
export interface PackageSourceListEntry extends PackageSourceIndexEntry {
	/** Null when repository fetching isn't configured, or the underlying cache entry can no longer be found (already evicted independently via repo_cache). */
	readonly cacheSizeBytes: number | null;
}

function identityKey(entry: PackageSourceIndexKey): string {
	return `${entry.ecosystem}/${entry.registry ?? ""}/${entry.name}/${entry.resolvedVersion}`;
}

function matches(entry: PackageSourceIndexEntry, query: PackageSourceIndexQuery): boolean {
	if (query.ecosystem !== undefined && entry.ecosystem !== query.ecosystem) return false;
	if (query.text !== undefined) {
		const needle = query.text.toLowerCase();
		const haystack = `${entry.ecosystem} ${entry.name} ${entry.resolvedVersion}`.toLowerCase();
		if (!haystack.includes(needle)) return false;
	}
	return true;
}

/**
 * Filters and paginates a PackageSourceIndexPort listing -- pure, no I/O. Sorted by canonical
 * identity (ecosystem/registry/name/resolvedVersion), not resolution time, so a cursor stays
 * meaningful across calls even if the underlying index is touched by a concurrent resolve
 * between pages. Mirrors queryCachedRepositories's own cursor discipline exactly.
 */
export function queryPackageSourceIndex(
	allEntries: readonly PackageSourceIndexEntry[],
	query: PackageSourceIndexQuery,
	maxResults: number,
	cursor?: string,
): PackageSourceIndexPage {
	if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new TypeError("maxResults must be a positive safe integer");

	const sorted = allEntries.filter((entry) => matches(entry, query)).sort((a, b) => identityKey(a).localeCompare(identityKey(b)));

	const startIndex = cursor === undefined ? 0 : sorted.findIndex((entry) => identityKey(entry) > cursor);
	const remaining = startIndex === -1 ? [] : sorted.slice(startIndex);

	const page = remaining.slice(0, maxResults);
	const lastOfPage = page.at(-1);
	const nextCursor = remaining.length > maxResults && lastOfPage ? identityKey(lastOfPage) : null;
	return { entries: page, nextCursor };
}
