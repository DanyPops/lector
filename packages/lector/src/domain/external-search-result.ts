/** Default maxResults for a caller (CLI, pi-lector tool) that doesn't specify one -- the service operation itself always requires an explicit value, this is purely a UX default shared across every external-search entry point. */
export const DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS = 20;

/** Shared bounds for every external-search adapter (GitHub, npm, Sourcegraph) -- same discipline as NpmRegistryBounds, applied to a second real network boundary. */
export interface ExternalSearchBounds {
	readonly maxResults: number;
	readonly timeoutMs: number;
	readonly maxResponseBytes: number;
	readonly maxRetries: number;
}

/** One GitHub repository search hit, shaped as a direct input to repo.fetch (host/owner/repo/ref). */
export interface GithubRepoCandidate {
	readonly host: string;
	readonly owner: string;
	readonly repo: string;
	readonly description: string | null;
	readonly stars: number;
	readonly language: string | null;
	readonly url: string;
}

export interface GithubRepoSearchResult {
	readonly candidates: readonly GithubRepoCandidate[];
	/** True when the search ran unauthenticated -- the caller is on GitHub's much tighter unauthenticated rate limit (10 req/min vs. 30 authenticated). */
	readonly authenticated: boolean;
}

/** One npm package search hit, shaped as a direct input to package.resolveSource (name, plus the version already returned). */
export interface NpmPackageCandidate {
	readonly name: string;
	readonly version: string;
	readonly description: string | null;
	readonly repositoryUrl: string | null;
	/** npm's own combined relevance score (0-1) for the query, not recomputed here. */
	readonly score: number;
}

/** One line match within one Sourcegraph code-search hit. */
export interface SourcegraphLineMatch {
	readonly line: number;
	readonly preview: string;
}

/** One Sourcegraph code-search hit, shaped as a direct input to repo.fetch once repository is split into host/owner/repo. */
export interface SourcegraphCodeCandidate {
	readonly repository: string;
	readonly path: string;
	readonly lineMatches: readonly SourcegraphLineMatch[];
	readonly url: string;
}

/** Splits Sourcegraph's own "host/owner/repo" repository field into repo.fetch's explicit fields -- null for anything that doesn't have exactly that shape (a non-GitHub-style forge path, an unexpected component count), never a guessed partial match. */
export function splitSourcegraphRepository(repository: string): { host: string; owner: string; repo: string } | null {
	const segments = repository.split("/");
	if (segments.length !== 3) return null;
	const [host, owner, repo] = segments;
	if (!host || !owner || !repo) return null;
	return { host, owner, repo };
}
