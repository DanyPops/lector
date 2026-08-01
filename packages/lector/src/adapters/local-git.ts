import simpleGit from "simple-git";
import { assertSafeGitArgument } from "../domain/assert-safe-git-argument.ts";
import type { GitDiffResult } from "../domain/git-diff-result.ts";
import type { GitLogEntry } from "../domain/git-log-entry.ts";
import type { GitStatusSummary } from "../domain/git-status.ts";
import type { GitPort } from "../ports/git-port.ts";

/**
 * GitPort backed by simple-git rather than a hand-rolled execFile wrapper --
 * its status/log parsers handle real cases (staged-vs-unstaged distinction,
 * branch ahead/behind) a first-pass implementation missed, and its
 * `blockUnsafeOperationsPlugin` (deny-by-category: `-c` config overrides,
 * `--upload-pack`, `--exec`, etc.) is registered unconditionally by
 * `simpleGit()` itself -- on by default, not something this adapter has to
 * opt into. assertSafeGitArgument on `ref` is deliberate defense in depth
 * on top of that, not a replacement for it.
 */
export class LocalGit implements GitPort {
	private readonly git: ReturnType<typeof simpleGit>;

	constructor(cwd: string) {
		this.git = simpleGit(cwd);
	}

	async isGitRepository(): Promise<boolean> {
		try {
			return await this.git.checkIsRepo();
		} catch {
			return false;
		}
	}

	async status(): Promise<GitStatusSummary> {
		const result = await this.git.status();
		return {
			files: result.files.map((file) =>
				file.from
					? { path: file.path, renamedFrom: file.from, indexStatus: file.index, workingDirStatus: file.working_dir }
					: { path: file.path, indexStatus: file.index, workingDirStatus: file.working_dir },
			),
			ahead: result.ahead,
			behind: result.behind,
			current: result.current,
			tracking: result.tracking,
		};
	}

	async log(maxCount: number): Promise<readonly GitLogEntry[]> {
		const result = await this.git.log({ maxCount });
		return result.all.map((entry) => ({
			sha: entry.hash,
			authorName: entry.author_name,
			authorEmail: entry.author_email,
			authoredAt: entry.date,
			message: entry.message,
		}));
	}

	async diff(ref: string | undefined, maxBytes: number): Promise<GitDiffResult> {
		const args: string[] = [];
		if (ref !== undefined) {
			assertSafeGitArgument(ref);
			args.push(ref);
		}
		// Marks the end of options: even a validated ref can never be reinterpreted as a flag by
		// git itself past this point -- defense in depth beyond assertSafeGitArgument and simple-git's
		// own blockUnsafeOperationsPlugin.
		args.push("--");
		const raw = await this.git.diff(args);
		const truncated = raw.length > maxBytes;
		return { diff: truncated ? raw.slice(0, maxBytes) : raw, truncated };
	}

	async showFile(ref: string, path: string): Promise<string | undefined> {
		assertSafeGitArgument(ref);
		// ":./path" (not "ref:path") is git's own syntax for a path relative to the current working
		// directory rather than the repository's top level -- this GitPort's cwd is the workspace
		// root, so this keeps `path` meaning exactly what every other Lector operation's `path`
		// argument already means, even when the workspace root is a subdirectory of a larger repo.
		try {
			return await this.git.show([`${ref}:./${path}`]);
		} catch (error) {
			// git's own stable wording for "the ref resolved fine, but this path isn't in that tree" --
			// distinct from a bad ref ("invalid object name"), which must still propagate as a real error.
			if (error instanceof Error && error.message.includes("does not exist in")) return undefined;
			throw error;
		}
	}
}
