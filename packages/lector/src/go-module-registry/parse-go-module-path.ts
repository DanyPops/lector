export interface ParsedGoModulePath {
	readonly host: string;
	readonly owner: string;
	readonly repo: string;
	/** The module's own path beyond its repo root, when it lives in a subdirectory of a larger repo (a real, common pattern -- e.g. github.com/sourcegraph/zoekt/gitindex) -- null when the module path names the whole repo. */
	readonly subdirectory: string | null;
}

/** The hosts Go's own tooling has always special-cased for a plain owner/repo path with no further metadata lookup (`go help importpath`). Any other host is a vanity import path, resolved only through its own go-import meta tag -- out of scope here; reported honestly as unrecognized rather than guessed at. */
const WELL_KNOWN_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

const MAJOR_VERSION_SUFFIX = /^v[2-9]\d*$/;

/**
 * Parses a Go module path into its real repo coordinates for a well-known VCS host, per Go's own
 * semantic-import-versioning convention: an optional `/vN` (N >= 2) major-version segment
 * immediately after `owner/repo` is part of the module's own identity, not a real path component,
 * and is dropped; anything remaining names a subdirectory within that repo.
 */
export function parseGoModulePath(modulePath: string): ParsedGoModulePath | null {
	const segments = modulePath.split("/").filter(Boolean);
	if (segments.length < 3) return null;
	const [host, owner, repo, ...rest] = segments;
	if (!host || !owner || !repo || !WELL_KNOWN_HOSTS.has(host)) return null;
	const subdirSegments = rest[0] && MAJOR_VERSION_SUFFIX.test(rest[0]) ? rest.slice(1) : rest;
	return { host, owner, repo, subdirectory: subdirSegments.length > 0 ? subdirSegments.join("/") : null };
}
