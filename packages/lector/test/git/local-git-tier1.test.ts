/**
 * LocalGit's Tier 1 ref-scoped queries -- grep/listFiles/isAncestor -- against a real git
 * repository, no checkout involved.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	const root = mkdtempSync(join(tmpdir(), "lector-git-tier1-fixture-"));
	git(root, "init", "-q", "--initial-branch=main");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "a.txt"), "hello world\n");
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "sub", "b.txt"), "hello nested\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "c1");
	return root;
}

describe("LocalGit.grep", () => {
	it("finds a real match across the whole tree at HEAD, with path/line/text", async () => {
		repoRoot = buildRepo();
		const result = await new LocalGit(repoRoot).grep("HEAD", "hello", undefined, 100, 10_000);
		expect(result.truncated).toBe(false);
		expect(result.matches).toContainEqual({ path: "a.txt", line: 1, text: "hello world" });
		expect(result.matches).toContainEqual({ path: "sub/b.txt", line: 1, text: "hello nested" });
	});

	it("returns no matches, not an error, when the pattern matches nothing", async () => {
		repoRoot = buildRepo();
		const result = await new LocalGit(repoRoot).grep("HEAD", "nomatch-at-all", undefined, 100, 10_000);
		expect(result.matches).toEqual([]);
		expect(result.truncated).toBe(false);
	});

	it("narrows the search by pathspec", async () => {
		repoRoot = buildRepo();
		const result = await new LocalGit(repoRoot).grep("HEAD", "hello", ["sub/*"], 100, 10_000);
		expect(result.matches).toEqual([{ path: "sub/b.txt", line: 1, text: "hello nested" }]);
	});

	it("scopes to a workspace rooted below the repository root, the same as diff/showFile", async () => {
		repoRoot = buildRepo();
		const result = await new LocalGit(join(repoRoot, "sub")).grep("HEAD", "hello", undefined, 100, 10_000);
		expect(result.matches).toEqual([{ path: "b.txt", line: 1, text: "hello nested" }]);
	});

	it("handles match text that itself contains colons without misparsing the line/path split", async () => {
		repoRoot = buildRepo();
		writeFileSync(join(repoRoot, "c.txt"), "time: 12:30:00 happened\n");
		git(repoRoot, "add", "c.txt");
		git(repoRoot, "commit", "-q", "-m", "c2");
		const result = await new LocalGit(repoRoot).grep("HEAD", "time", undefined, 100, 10_000);
		expect(result.matches).toContainEqual({ path: "c.txt", line: 1, text: "time: 12:30:00 happened" });
	});

	it("truncates past maxMatches", async () => {
		repoRoot = buildRepo();
		const result = await new LocalGit(repoRoot).grep("HEAD", "hello", undefined, 1, 10_000);
		expect(result.matches.length).toBe(1);
		expect(result.truncated).toBe(true);
	});

	it("rejects a ref that looks like a flag", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).grep("--upload-pack=evil", "hello", undefined, 100, 10_000)).rejects.toBeInstanceOf(UnsafeGitArgument);
	});

	it("throws GitRevisionNotFound for a ref that does not resolve", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).grep("no-such-ref", "hello", undefined, 100, 10_000)).rejects.toBeInstanceOf(GitRevisionNotFound);
	});
});

describe("LocalGit.listFiles", () => {
	it("lists every real file path in the tree at ref", async () => {
		repoRoot = buildRepo();
		const result = await new LocalGit(repoRoot).listFiles("HEAD", undefined, 100);
		expect([...result.paths].sort()).toEqual(["a.txt", "sub/b.txt"]);
		expect(result.truncated).toBe(false);
	});

	it("narrows the listing by pathspec -- ls-tree's own pathspec matching is prefix-based, not glob-based, unlike grep's", async () => {
		repoRoot = buildRepo();
		const result = await new LocalGit(repoRoot).listFiles("HEAD", ["sub"], 100);
		expect(result.paths).toEqual(["sub/b.txt"]);
	});

	it("scopes to a workspace rooted below the repository root", async () => {
		repoRoot = buildRepo();
		const result = await new LocalGit(join(repoRoot, "sub")).listFiles("HEAD", undefined, 100);
		expect(result.paths).toEqual(["b.txt"]);
	});

	it("truncates past maxResults", async () => {
		repoRoot = buildRepo();
		const result = await new LocalGit(repoRoot).listFiles("HEAD", undefined, 1);
		expect(result.paths.length).toBe(1);
		expect(result.truncated).toBe(true);
	});

	it("rejects a ref that looks like a flag", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).listFiles("--upload-pack=evil", undefined, 100)).rejects.toBeInstanceOf(UnsafeGitArgument);
	});

	it("throws GitRevisionNotFound for a ref that does not resolve", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).listFiles("no-such-ref", undefined, 100)).rejects.toBeInstanceOf(GitRevisionNotFound);
	});
});

describe("LocalGit.isAncestor", () => {
	it("is true when the first commit really is an ancestor of the second", async () => {
		repoRoot = buildRepo();
		const c1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
		writeFileSync(join(repoRoot, "a.txt"), "changed\n");
		git(repoRoot, "commit", "-qam", "c2");
		const c2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();

		expect(await new LocalGit(repoRoot).isAncestor(c1, c2)).toBe(true);
	});

	it("is false the other way around", async () => {
		repoRoot = buildRepo();
		const c1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
		writeFileSync(join(repoRoot, "a.txt"), "changed\n");
		git(repoRoot, "commit", "-qam", "c2");
		const c2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();

		expect(await new LocalGit(repoRoot).isAncestor(c2, c1)).toBe(false);
	});

	it("is true for a ref compared against itself", async () => {
		repoRoot = buildRepo();
		expect(await new LocalGit(repoRoot).isAncestor("HEAD", "HEAD")).toBe(true);
	});

	it("is false for two commits with genuinely no common history", async () => {
		repoRoot = buildRepo();
		const c1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
		git(repoRoot, "checkout", "-q", "--orphan", "orphan-branch");
		execFileSync("git", ["rm", "-rqf", "."], { cwd: repoRoot });
		writeFileSync(join(repoRoot, "d.txt"), "other\n");
		git(repoRoot, "add", "d.txt");
		git(repoRoot, "commit", "-q", "-m", "orphan commit");

		expect(await new LocalGit(repoRoot).isAncestor(c1, "HEAD")).toBe(false);
	});

	it("rejects a ref that looks like a flag", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).isAncestor("--upload-pack=evil", "HEAD")).rejects.toBeInstanceOf(UnsafeGitArgument);
	});

	it("throws GitRevisionNotFound when either ref does not resolve", async () => {
		repoRoot = buildRepo();
		await expect(new LocalGit(repoRoot).isAncestor("no-such-ref", "HEAD")).rejects.toBeInstanceOf(GitRevisionNotFound);
		await expect(new LocalGit(repoRoot).isAncestor("HEAD", "no-such-ref")).rejects.toBeInstanceOf(GitRevisionNotFound);
	});
});
