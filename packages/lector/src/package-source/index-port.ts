import type { PackageSourceIndexEntry, PackageSourceIndexKey } from "./package-source-index.ts";

/** The daemon's own bookkeeping of every package coordinate it has resolved to a verified source workspace -- distinct from RepoFetcherPort's disk cache, which addresses by (host, owner, repo, ref) and has no notion of package identity. */
export interface PackageSourceIndexPort {
	/** Records (or refreshes, if the same key was already recorded) one resolved package source. */
	record(entry: PackageSourceIndexEntry): Promise<void>;
	/** Every entry currently recorded -- no I/O beyond the store itself. */
	list(): Promise<readonly PackageSourceIndexEntry[]>;
	/** Removes one entry by its exact key. Returns false, not an error, when nothing was recorded for that key. */
	remove(key: PackageSourceIndexKey): Promise<boolean>;
}
