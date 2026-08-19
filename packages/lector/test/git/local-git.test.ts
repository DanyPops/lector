/**
 * LocalGit against a real git repository -- real init, real commits, real
 * status/log/diff via simple-git, not a mocked git binary.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnsafeGitArgument } from "../../src/git/assert-safe-git-argument.ts";
import { LocalGit } from "../../src/git/local-git.ts";
import { GitRevisionNotFound } from "../../src/git/revision-not-found.ts";

let repoRoot: string | undefined;

afterEach(() => {
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
	repoRoot = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-git-fixture-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "a.txt"), "hello\n");
	git(root, "add", "a.txt");
	git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

describe("LocalGit", () => {
	it("isGitRepository is true for a real repo and false for a plain directory", async () => {
		repoRoot = buildRepo();
		const gitPort = new LocalGit(repoRoot);
		expect(await gitPort.isGitRepository()).toBe(true);

		const plainDir = mkdtempSync(join(tmpdir(), "lector-not-git-"));
		try {
			expect(await new LocalGit(plainDir).isGitRepository()).toBe(false);
		} finally {
			rmSync(plainDir, { recursive: true, force: true });
		}
	});

	it("status reports a real modified file and a real untracked file, with index/working-dir status split", async () => {
		repoRoot = buildRepo();
		writeFileSync(join(repoRoot, "a.txt"), "changed\n");
		writeFileSync(join(repoRoot, "new.txt"), "new\n");

		const summary = await new LocalGit(repoRoot).status();

		expect(summary.files).toContainEqual({ path: "a.txt", indexStatus: " ", workingDirStatus: "M" });
		expect(summary.files).toContainEqual({ path: "new.txt", indexStatus: "?", workingDirStatus: "?" });
	});

	it("status reports a real rename with its origin path", async () => {
		repoRoot = buildRepo();
		git(repoRoot, "mv", "a.txt", "b.txt");

		const summary = await new LocalGit(repoRoot).status();

		const renamed = summary.files.find((file) => file.path === "b.txt");
		expect(renamed?.renamedFrom).toBe("a.txt");
	});

	it("status reports the current branch name", async () => {
		repoRoot = buildRepo();
		const summary = await new LocalGit(repoRoot).status();
		expect(typeof summary.current).toBe("string");
	});

	it("log returns real commits, most recent first, bounded to maxCount", async () => {
		repoRoot = buildRepo();
		writeFileSync(join(repoRoot, "b.txt"), "second\n");
		git(repoRoot, "add", "b.txt");
		git(repoRoot, "commit", "-q", "-m", "second commit");

		const entries = await new LocalGit(repoRoot).log(1);

		expect(entries.length).toBe(1);
		expect(entries[0]?.message).toBe("second commit");
		expect(entries[0]?.authorEmail).toBe("t@t.com");
		expect(entries[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("diff against HEAD shows a real uncommitted change", async () => {
		repoRoot = buildRepo();
		writeFileSync(join(repoRoot, "a.txt"), "changed content\n");

		const result = await new LocalGit(repoRoot).diff(undefined, 10_000);

		expect(result.truncated).toBe(false);
		expect(result.diff).toContain("-hello");
		expect(result.diff).toContain("+changed content");
		expect(result.files).toEqual([
			expect.objectContaining({
				path: "a.txt",
				status: "modified",
				binary: false,
				hunks: [expect.objectContaining({ oldStart: 1, newStart: 1 })],
			}),
		]);
	});

	it("diff paths stay relative to a workspace rooted below the repository root", async () => {
		repoRoot = buildRepo();
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(repoRoot, "sub"));
		writeFileSync(join(repoRoot, "sub/b.txt"), "before\n");
		git(repoRoot, "add", "sub/b.txt");
		git(repoRoot, "commit", "-q", "-m", "add nested file");
		writeFileSync(join(repoRoot, "sub/b.txt"), "after\n");

		const result = await new LocalGit(join(repoRoot, "sub")).diff(undefined, 10_000);

		expect(result.files[0]?.path).toBe("b.txt");
		expect(result.diff).not.toContain("a/sub/b.txt");
	});

	it("diff truncates past maxBytes rather than returning an unbounded string", async () => {
		repoRoot = buildRepo();
		writeFileSync(join(repoRoot, "a.txt"), "x".repeat(5000));

		const result = await new LocalGit(repoRoot).diff(undefined, 100);

		expect(result.truncated).toBe(true);
		expect(result.diff.length).toBe(100);
	});

	it("rejects a ref that looks like a flag, rather than letting it reach git's own argv parser", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).diff("--upload-pack=evil", 1000)).rejects.toBeInstanceOf(UnsafeGitArgument);
	});

	it("translates an unresolved diff revision into a stable domain error", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).diff("not-a-real-ref", 1000)).rejects.toBeInstanceOf(GitRevisionNotFound);
	});

	it("showFile returns a path's exact blob content at a real ref", async () => {
		repoRoot = buildRepo();
		const content = await new LocalGit(repoRoot).showFile("HEAD", "a.txt");
		expect(content).toBe("hello\n");
	});

	it("showFile resolves a path relative to the workspace root, not the git repository's top level", async () => {
		repoRoot = buildRepo();
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(repoRoot, "sub"));
		writeFileSync(join(repoRoot, "sub", "b.txt"), "nested\n");
		git(repoRoot, "add", "sub/b.txt");
		git(repoRoot, "commit", "-q", "-m", "add nested file");

		const content = await new LocalGit(join(repoRoot, "sub")).showFile("HEAD", "b.txt");
		expect(content).toBe("nested\n");
	});

	it("showFile returns undefined when the path does not exist at a valid ref, not an error", async () => {
		repoRoot = buildRepo();
		const content = await new LocalGit(repoRoot).showFile("HEAD", "missing.txt");
		expect(content).toBeUndefined();
	});

	it("showFile still throws for a genuinely invalid ref, distinct from a missing path", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).showFile("no-such-ref", "a.txt")).rejects.toBeInstanceOf(GitRevisionNotFound);
	});

	it("showFile rejects a ref that looks like a flag", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).showFile("--upload-pack=evil", "a.txt")).rejects.toBeInstanceOf(UnsafeGitArgument);
	});

	it("resolveCommit resolves a ref to its real 40-hex commit sha", async () => {
		repoRoot = buildRepo();
		const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
		expect(await new LocalGit(repoRoot).resolveCommit("HEAD")).toBe(headSha);
	});

	it("resolveCommit rejects a ref that looks like a flag", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).resolveCommit("--upload-pack=evil")).rejects.toBeInstanceOf(UnsafeGitArgument);
	});

	it("resolveCommit throws GitRevisionNotFound for an invalid ref", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).resolveCommit("no-such-ref")).rejects.toBeInstanceOf(GitRevisionNotFound);
	});

	describe("addWorktree/removeWorktree", () => {
		let worktreeDir: string | undefined;

		afterEach(() => {
			if (worktreeDir) rmSync(worktreeDir, { recursive: true, force: true });
			worktreeDir = undefined;
		});

		it("checks out a real detached worktree at ref, with the file content real at that ref", async () => {
			repoRoot = buildRepo();
			worktreeDir = join(tmpdir(), `lector-worktree-${Date.now()}`);

			const { commit } = await new LocalGit(repoRoot).addWorktree("HEAD", worktreeDir);

			const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
			expect(commit).toBe(headSha);
			expect(readFileSync(join(worktreeDir, "a.txt"), "utf8")).toBe("hello\n");
			// Detached, not tracking any branch -- a later change on the source repo's own checked-out
			// branch must never move this worktree out from under a caller reading it.
			const status = execFileSync("git", ["status", "--branch", "--porcelain=v2"], { cwd: worktreeDir }).toString();
			expect(status).toContain("# branch.head (detached)");
		});

		it("rejects a ref that does not resolve, without leaving a worktree behind", async () => {
			repoRoot = buildRepo();
			worktreeDir = join(tmpdir(), `lector-worktree-${Date.now()}`);

			await expect(new LocalGit(repoRoot).addWorktree("no-such-ref", worktreeDir)).rejects.toBeInstanceOf(GitRevisionNotFound);
			expect(existsSync(worktreeDir)).toBe(false);
		});

		it("self-heals a targetDir already registered as a worktree from a prior call, instead of failing", async () => {
			repoRoot = buildRepo();
			worktreeDir = join(tmpdir(), `lector-worktree-${Date.now()}`);
			const gitPort = new LocalGit(repoRoot);
			await gitPort.addWorktree("HEAD", worktreeDir);

			// A fresh LocalGit instance (standing in for a daemon restart, which loses the in-memory
			// registry but never git's own on-disk worktree admin state) re-adding at the same path
			// must succeed by clearing the stale entry, not surface a "path already exists" failure.
			const { commit } = await new LocalGit(repoRoot).addWorktree("HEAD", worktreeDir);
			const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
			expect(commit).toBe(headSha);
			expect(readFileSync(join(worktreeDir, "a.txt"), "utf8")).toBe("hello\n");
		});

		it("removeWorktree deletes the directory and git's own admin entry for it", async () => {
			repoRoot = buildRepo();
			worktreeDir = join(tmpdir(), `lector-worktree-${Date.now()}`);
			const gitPort = new LocalGit(repoRoot);
			await gitPort.addWorktree("HEAD", worktreeDir);

			await gitPort.removeWorktree(worktreeDir);

			expect(existsSync(worktreeDir)).toBe(false);
			const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot }).toString();
			expect(list).not.toContain(worktreeDir);
		});

		it("removeWorktree is safe to call even after the directory was already deleted out-of-band", async () => {
			repoRoot = buildRepo();
			worktreeDir = join(tmpdir(), `lector-worktree-${Date.now()}`);
			const gitPort = new LocalGit(repoRoot);
			await gitPort.addWorktree("HEAD", worktreeDir);
			rmSync(worktreeDir, { recursive: true, force: true });

			await gitPort.removeWorktree(worktreeDir);

			const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot }).toString();
			expect(list).not.toContain(worktreeDir);
		});
	});
});
