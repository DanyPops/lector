/**
 * Go's pseudo-version suffix (`golang.org/x/mod/module`'s own format): `-yyyymmddhhmmss-<12 hex
 * chars>` appended to a base version, used whenever a require has no real tagged release to
 * point at. The trailing 12 hex characters are always an abbreviated commit hash -- extracting
 * it lets the source resolver skip an ambiguous ref guess entirely and check out that exact
 * commit directly.
 */
const PSEUDO_VERSION = /-(?:0\.)?\d{14}-([0-9a-f]{12})$/;

export function pseudoVersionCommit(version: string): string | null {
	const match = PSEUDO_VERSION.exec(version);
	return match ? (match[1] ?? null) : null;
}

const FULL_COMMIT_HASH = /^[0-9a-f]{40}$/i;

/** True for a full 40-character git commit SHA -- the shape a replace directive's own version field takes when it names an exact VCS commit rather than a tagged module version. */
export function looksLikeCommitHash(value: string): boolean {
	return FULL_COMMIT_HASH.test(value);
}

/** Per go.mod's own grammar, a replace directive's replacement path is a local filesystem path if and only if it is absolute or begins with `./`/`../` -- every other shape is a module path, remote by definition. */
export function isLocalReplacePath(path: string): boolean {
	return path.startsWith("/") || path.startsWith("./") || path.startsWith("../");
}
