import type { RepoReference } from "../repo-fetcher/repo-reference.ts";

export interface NormalizedGitRepository {
	readonly url: string;
	readonly host: string;
	readonly owner: string;
	readonly repo: string;
}

/**
 * Parses any `https://host/owner/repo[.git]` URL into its own real parts -- shared across every
 * ecosystem's own source resolver (PyPI's project_urls, crates.io's own `repository` field, a
 * direct-VCS install's directSource) since a real repository URL takes the same shape regardless
 * of which registry reported it.
 */
export function normalizeGitRepositoryUrl(raw: string): NormalizedGitRepository | null {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (!["https:", "http:"].includes(parsed.protocol) || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
	const segments = parsed.pathname
		.replace(/^\//, "")
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	if (segments.length !== 2) return null;
	const [owner, repo] = segments;
	if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") return null;
	const host = parsed.hostname.toLowerCase();
	return { url: `https://${host}/${owner}/${repo}.git`, host, owner, repo };
}

export function gitRepositoryReference(repository: NormalizedGitRepository, ref: string): RepoReference {
	return { host: repository.host, owner: repository.owner, repo: repository.repo, ref };
}
