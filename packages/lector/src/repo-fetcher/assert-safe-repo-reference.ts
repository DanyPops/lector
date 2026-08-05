import { assertSafeGitArgument } from "../git/assert-safe-git-argument.ts";
import { assertSafePathSegment } from "../path-safety/assert-safe-path-segment.ts";
import type { RepoReference } from "../repo-fetcher/repo-reference.ts";

/**
 * Validates every caller-influenced field of a RepoReference before it reaches a git argv or a
 * cache-directory path. host/owner/repo become single directory segments -- no separators, no
 * "..". ref may contain "/" (branch namespacing, e.g. "feature/x") but each of its own segments
 * still can't be "..", and the whole value can't start with "-" (git argv-flag injection).
 */
export function assertSafeRepoReference(reference: RepoReference): void {
	assertSafePathSegment(reference.host, "host");
	assertSafePathSegment(reference.owner, "owner");
	assertSafePathSegment(reference.repo, "repo");
	if (reference.ref === null) return;
	assertSafeGitArgument(reference.ref);
	for (const segment of reference.ref.split("/")) {
		assertSafePathSegment(segment, "ref segment");
	}
}
