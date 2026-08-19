import { readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

const GITDIR_LINE = /^gitdir:\s*(.+)$/m;

/**
 * A linked worktree's root has a `.git` FILE (not a directory) pointing back at
 * `<mainRepo>/.git/worktrees/<name>` -- the one piece of on-disk state that reliably answers
 * "is this actually a worktree, and if so, of what repo" without any bookkeeping of our own
 * (workspace.gitWorktreeAdd's own registry entry does not survive a daemon restart; this does).
 * Returns undefined for anything else -- a real repository root, a plain directory, or a path
 * that no longer exists -- never guessed at or asserted on faith.
 */
export async function resolveWorktreeMainRoot(worktreePath: string): Promise<string | undefined> {
	let content: string;
	try {
		content = await readFile(join(worktreePath, ".git"), "utf8");
	} catch {
		return undefined;
	}
	const match = GITDIR_LINE.exec(content.trim());
	if (!match) return undefined;
	const gitDir = match[1]?.trim();
	if (!gitDir) return undefined;
	const marker = `${sep}worktrees${sep}`;
	const markerIndex = gitDir.indexOf(marker);
	if (markerIndex === -1) return undefined;
	const dotGitDir = gitDir.slice(0, markerIndex); // "<mainRepo>/.git"
	return dirname(dotGitDir);
}
