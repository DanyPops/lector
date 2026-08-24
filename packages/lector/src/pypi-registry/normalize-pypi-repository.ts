import { gitRepositoryReference, type NormalizedGitRepository, normalizeGitRepositoryUrl } from "../package-source/normalize-git-repository-url.ts";

export type NormalizedPypiRepository = NormalizedGitRepository;

/** Checked case-insensitively, in priority order, before falling back to scanning every project_urls value -- the community-recognized labels PyPI's own project page gives special treatment to. */
const REPOSITORY_LABEL_PRIORITY = ["source code", "source", "repository", "code", "github"];

/** Parses any `https://host/owner/repo[.git]` URL into its own real parts -- exported for reuse against a direct-VCS install's own `directSource` URL, not only PyPI's project_urls, since the same owner/repo shape is what a RepoReference needs either way. Delegates to the shared cross-ecosystem parser; kept as its own named export since PyPI-specific call sites already depend on this exact name. */
export const parseOwnerRepoUrl = normalizeGitRepositoryUrl;

/**
 * PyPI's own JSON API has no single canonical "repository" field the way npm's `repository` does
 * -- `project_urls` is a free-form label -> URL map the project itself chose. Tries the
 * community-recognized labels first (matching PyPI's own project-page icon conventions), then
 * falls back to scanning every value for anything owner/repo-shaped (a project with only a
 * "Homepage" label that already points straight at its repo is common and should still resolve).
 * Any host is accepted, not just github.com/gitlab.com/bitbucket.org -- a private index's own
 * internal git host is exactly as valid a source of truth as a public one.
 */
export function normalizePypiRepository(projectUrls: Readonly<Record<string, string>> | null): NormalizedPypiRepository | null {
	if (projectUrls === null) return null;
	for (const label of REPOSITORY_LABEL_PRIORITY) {
		const match = Object.entries(projectUrls).find(([key]) => key.trim().toLowerCase() === label);
		const normalized = match && parseOwnerRepoUrl(match[1]);
		if (normalized) return normalized;
	}
	for (const value of Object.values(projectUrls)) {
		const normalized = parseOwnerRepoUrl(value);
		if (normalized) return normalized;
	}
	return null;
}

export const pypiRepositoryReference = gitRepositoryReference;
