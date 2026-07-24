/** Identifies one external repo checkout: host/owner/repo plus an optional ref (branch/tag/sha). `ref: null` means "the remote's default branch". */
export interface RepoReference {
	readonly host: string;
	readonly owner: string;
	readonly repo: string;
	readonly ref: string | null;
}
