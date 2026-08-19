import { createHash } from "node:crypto";
import { join } from "node:path";

/** Every character git itself would reject or require quoting in a ref name, collapsed to "_" so the derived path is always a single safe directory segment. */
function sanitizeRefForPath(ref: string): string {
	const sanitized = ref.replace(/[^a-zA-Z0-9._-]/g, "_");
	return sanitized.length > 0 ? sanitized : "ref";
}

/** Short, stable digest of a repo's own absolute root -- distinct repos never collide under the same worktreesRoot, and the same repo's own worktrees always land under one directory. */
function repoDirName(repoRootPath: string): string {
	return createHash("sha256").update(repoRootPath).digest("hex").slice(0, 16);
}

/**
 * Deterministic worktree path for (repoRootPath, ref) -- the same pair always resolves to the
 * same directory, so a second workspace.gitWorktreeAdd for a ref already checked out reuses it
 * (workspace.registerPath's own idempotent-by-derived-path precedent) instead of accumulating a
 * fresh directory, and therefore a fresh registered workspace, per call.
 */
export function worktreePathFor(worktreesRoot: string, repoRootPath: string, ref: string): string {
	return join(worktreesRoot, repoDirName(repoRootPath), sanitizeRefForPath(ref));
}
