import { rm } from "node:fs/promises";
import simpleGit from "simple-git";
import { truncateUtf8 } from "../bounds/truncate-utf8.ts";
import { assertSafeGitArgument } from "./assert-safe-git-argument.ts";
import type { GitDiffResult } from "./diff-result.ts";
import type { GitGrepMatch, GitGrepResult } from "./grep-result.ts";
import type { GitListFilesResult } from "./list-files-result.ts";
import type { GitLogEntry } from "./log-entry.ts";
import type { GitPort } from "./port.ts";
import { GitRevisionNotFound, gitErrorIsMissingRevision } from "./revision-not-found.ts";
import type { GitStatusSummary } from "./status.ts";
import { parseUnifiedGitDiff } from "./unified-diff.ts";

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
		const args: string[] = ["--relative"];
		if (ref !== undefined) {
			assertSafeGitArgument(ref);
			args.push(ref);
		}
		// Marks the end of options: even a validated ref can never be reinterpreted as a flag by
		// git itself past this point -- defense in depth beyond assertSafeGitArgument and simple-git's
		// own blockUnsafeOperationsPlugin.
		args.push("--");
		try {
			const raw = await this.git.diff(args);
			const bounded = truncateUtf8(raw, maxBytes);
			return { diff: bounded.value, files: parseUnifiedGitDiff(bounded.value), truncated: bounded.truncated };
		} catch (error) {
			if (ref !== undefined && gitErrorIsMissingRevision(error)) throw new GitRevisionNotFound(ref);
			throw error;
		}
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
			// distinct from a bad ref, which is translated into a stable domain error.
			if (error instanceof Error && error.message.includes("does not exist in")) return undefined;
			if (gitErrorIsMissingRevision(error)) throw new GitRevisionNotFound(ref);
			throw error;
		}
	}

	async resolveCommit(ref: string): Promise<string> {
		assertSafeGitArgument(ref);
		try {
			const out = await this.git.raw(["rev-parse", `${ref}^{commit}`]);
			return out.trim();
		} catch (error) {
			if (gitErrorIsMissingRevision(error)) throw new GitRevisionNotFound(ref);
			throw error;
		}
	}

	async addWorktree(ref: string, targetDir: string): Promise<{ commit: string }> {
		assertSafeGitArgument(ref);
		const attemptAdd = () => this.git.raw(["worktree", "add", "--detach", targetDir, ref]);
		try {
			await attemptAdd();
		} catch (error) {
			if (gitErrorIsMissingRevision(error)) throw new GitRevisionNotFound(ref);
			// Not a missing-revision failure -- most likely targetDir is already a registered worktree
			// left behind by a prior process (see addWorktree's own doc comment). Clear it and retry
			// once; a real, different failure (e.g. a genuinely unsafe targetDir) still surfaces from
			// this second attempt rather than being swallowed.
			await this.git.raw(["worktree", "remove", "--force", targetDir]).catch(() => undefined);
			await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
			await this.git.raw(["worktree", "prune"]).catch(() => undefined);
			await attemptAdd();
		}
		return { commit: await this.resolveCommit(ref) };
	}

	async removeWorktree(targetDir: string): Promise<void> {
		try {
			await this.git.raw(["worktree", "remove", "--force", targetDir]);
		} catch {
			// Already gone from disk, or git never fully registered it -- prune git's own stale admin
			// entry and finish the removal by hand rather than surfacing a false failure.
			await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
			await this.git.raw(["worktree", "prune"]).catch(() => undefined);
		}
	}

	async grep(ref: string, pattern: string, pathspecs: readonly string[] | undefined, maxMatches: number, maxBytes: number): Promise<GitGrepResult> {
		assertSafeGitArgument(ref);
		// "-e" marks the following argument as the pattern itself, never reinterpreted as a flag by
		// git even if it starts with "-" -- unlike ref/pathspecs, a search pattern legitimately can.
		const args = ["grep", "-n", "-e", pattern, ref];
		if (pathspecs && pathspecs.length > 0) args.push("--", ...pathspecs);
		let raw: string;
		try {
			raw = await this.git.raw(args);
		} catch (error) {
			// A real "no matches" (exit 1, no stderr) resolves rather than throws -- see grep's own
			// GitPort doc comment. Only a genuinely bad ref reaches this catch.
			if (gitErrorIsMissingRevision(error)) throw new GitRevisionNotFound(ref);
			throw error;
		}
		const bounded = truncateUtf8(raw, maxBytes);
		// git echoes the literal ref string back as each line's own prefix when searching a tree
		// rather than the working directory -- stripping it is exact, not a heuristic.
		const prefix = `${ref}:`;
		const lineShape = /^(.+?):(\d+):(.*)$/;
		const matches: GitGrepMatch[] = [];
		for (const line of bounded.value.split("\n")) {
			if (line.length === 0 || !line.startsWith(prefix)) continue;
			const parsed = lineShape.exec(line.slice(prefix.length));
			if (!parsed) continue; // a byte-truncated partial line at the maxBytes boundary
			const [, path, lineNumber, text] = parsed;
			matches.push({ path: path ?? "", line: Number(lineNumber), text: text ?? "" });
		}
		return { matches: matches.slice(0, maxMatches), truncated: bounded.truncated || matches.length > maxMatches };
	}

	async listFiles(ref: string, pathspecs: readonly string[] | undefined, maxResults: number): Promise<GitListFilesResult> {
		assertSafeGitArgument(ref);
		const args = ["ls-tree", "-r", "--name-only", ref];
		if (pathspecs && pathspecs.length > 0) args.push("--", ...pathspecs);
		let raw: string;
		try {
			raw = await this.git.raw(args);
		} catch (error) {
			if (gitErrorIsMissingRevision(error)) throw new GitRevisionNotFound(ref);
			throw error;
		}
		const allPaths = raw.split("\n").filter((line) => line.length > 0);
		return { paths: allPaths.slice(0, maxResults), truncated: allPaths.length > maxResults };
	}

	async isAncestor(ancestorRef: string, ref: string): Promise<boolean> {
		const [ancestorCommit, commit] = await Promise.all([this.resolveCommit(ancestorRef), this.resolveCommit(ref)]);
		// Both sides are now real, already-validated commit shas -- merge-base's own output (a real
		// sha on success, empty on genuinely unrelated histories) is what's compared, never an exit
		// code simple-git doesn't reliably surface for this command (see isAncestor's own GitPort doc).
		const mergeBase = (await this.git.raw(["merge-base", ancestorCommit, commit])).trim();
		return mergeBase === ancestorCommit;
	}
}
