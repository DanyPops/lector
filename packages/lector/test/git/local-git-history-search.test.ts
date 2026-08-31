import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidGitSearchPattern } from "../../src/git/invalid-search-pattern.ts";
import { LocalGit } from "../../src/git/local-git.ts";

let repoRoot: string | undefined;

afterEach(() => {
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
	repoRoot = undefined;
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(root: string, message: string, content: string): string {
	writeFileSync(join(root, "search.txt"), content);
	git(root, "add", "search.txt");
	git(root, "commit", "-q", "-m", message);
	return git(root, "rev-parse", "HEAD");
}

function buildHistory(): { root: string; newest: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-git-history-search-"));
	git(root, "init", "-q", "--initial-branch=main");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	commit(root, "initial", "shared needle\n");
	commit(root, "middle", "shared needle\nmain-only needle\n");
	const newest = commit(root, "newest", "shared needle\nmain-only needle\nnewest needle\n");
	git(root, "branch", "historical-branch", "HEAD~2");
	return { root, newest };
}

const BOUNDS = { commitOffset: 0, maxCommits: 100, maxMatches: 100, maxBytes: 100_000, deadlineMs: 5_000 };

describe("LocalGit.grepHistory", () => {
	it("searches all reachable refs and returns deterministic commit provenance", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		git(repoRoot, "checkout", "-q", "historical-branch");
		writeFileSync(join(repoRoot, "branch.txt"), "branch-only needle\n");
		git(repoRoot, "add", "branch.txt");
		git(repoRoot, "commit", "-q", "-m", "branch only");
		const branchCommit = git(repoRoot, "rev-parse", "HEAD");
		git(repoRoot, "checkout", "-q", "main");
		const result = await new LocalGit(repoRoot).grepHistory("needle", undefined, BOUNDS);

		expect(result.provenance).toEqual({
			scope: "all-refs",
			traversal: "topo-order",
			binaryFiles: "excluded",
			deduplication: "path-line-text",
			commitOffset: 0,
		});
		expect(result.deadlineReached).toBe(false);
		expect(result.matches).toContainEqual({ path: "search.txt", line: 3, text: "newest needle", commit: fixture.newest, occurrences: 1 });
		expect(result.matches).toContainEqual({ path: "branch.txt", line: 1, text: "branch-only needle", commit: branchCommit, occurrences: 1 });
	});

	it("returns a complete empty result when no commit contains the pattern", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		const result = await new LocalGit(repoRoot).grepHistory("absent-pattern", undefined, BOUNDS);
		expect(result.matches).toEqual([]);
		expect(result.truncated).toBe(false);
		expect(result.deadlineReached).toBe(false);
	});

	it("deduplicates an unchanged line across commits and reports its occurrence count", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		const result = await new LocalGit(repoRoot).grepHistory("shared", undefined, BOUNDS);

		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({ path: "search.txt", line: 1, text: "shared needle", commit: fixture.newest, occurrences: 3 });
	});

	it("supports bounded commit pages across the same topological traversal", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		const localGit = new LocalGit(repoRoot);
		const first = await localGit.grepHistory("needle", undefined, { ...BOUNDS, maxCommits: 1 });
		const second = await localGit.grepHistory("needle", undefined, { ...BOUNDS, commitOffset: first.nextCommitOffset ?? 0, maxCommits: 1 });

		expect(first.scannedCommits).toBe(1);
		expect(first.commitsTruncated).toBe(true);
		expect(first.nextCommitOffset).toBe(1);
		expect(first.matches.some((match) => match.text === "newest needle")).toBe(true);
		expect(second.scannedCommits).toBe(1);
		expect(second.matches.some((match) => match.text === "newest needle")).toBe(false);
	});

	it("includes merge commits instead of following first-parent history only", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		git(repoRoot, "checkout", "-qb", "feature", "HEAD~1");
		writeFileSync(join(repoRoot, "feature.txt"), "merged needle\n");
		git(repoRoot, "add", "feature.txt");
		git(repoRoot, "commit", "-q", "-m", "feature");
		git(repoRoot, "checkout", "-q", "main");
		git(repoRoot, "merge", "-q", "--no-ff", "feature", "-m", "merge feature");
		const mergeCommit = git(repoRoot, "rev-parse", "HEAD");

		const result = await new LocalGit(repoRoot).grepHistory("merged needle", undefined, BOUNDS);
		expect(result.matches).toContainEqual({ path: "feature.txt", line: 1, text: "merged needle", commit: mergeCommit, occurrences: 2 });
	});

	it("narrows matches with git pathspecs and excludes binary files", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		writeFileSync(join(repoRoot, "binary.dat"), Buffer.from("binary needle\0payload"));
		git(repoRoot, "add", "binary.dat");
		git(repoRoot, "commit", "-q", "-m", "binary");

		const text = await new LocalGit(repoRoot).grepHistory("needle", ["*.txt"], BOUNDS);
		const binary = await new LocalGit(repoRoot).grepHistory("needle", ["*.dat"], BOUNDS);
		expect(text.matches.length).toBeGreaterThan(0);
		expect(binary.matches).toEqual([]);
	});

	it("scopes paths and matches to a workspace below the repository root", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		mkdirSync(join(repoRoot, "sub"));
		writeFileSync(join(repoRoot, "sub", "nested.txt"), "nested needle\n");
		writeFileSync(join(repoRoot, "sibling.txt"), "sibling needle\n");
		git(repoRoot, "add", "sub/nested.txt", "sibling.txt");
		git(repoRoot, "commit", "-q", "-m", "workspace scope");

		const result = await new LocalGit(join(repoRoot, "sub")).grepHistory("needle", undefined, BOUNDS);
		expect(result.matches).toContainEqual(expect.objectContaining({ path: "nested.txt", text: "nested needle" }));
		expect(result.matches.some((match) => match.path.includes("sibling.txt"))).toBe(false);
	});

	it("preserves paths containing colon-number segments", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		writeFileSync(join(repoRoot, "part:7:file.txt"), "colon needle\n");
		git(repoRoot, "add", "part:7:file.txt");
		git(repoRoot, "commit", "-q", "-m", "colon path");

		const result = await new LocalGit(repoRoot).grepHistory("colon needle", ["part:7:file.txt"], BOUNDS);
		expect(result.matches).toContainEqual(expect.objectContaining({ path: "part:7:file.txt", line: 1, text: "colon needle" }));
	});

	it("reports result truncation at maxMatches and maxBytes", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		const localGit = new LocalGit(repoRoot);
		const byMatches = await localGit.grepHistory("needle", undefined, { ...BOUNDS, maxMatches: 1 });
		const byBytes = await localGit.grepHistory("needle", undefined, { ...BOUNDS, maxBytes: 8 });

		expect(byMatches.matches).toHaveLength(1);
		expect(byMatches.truncated).toBe(true);
		expect(byBytes.truncated).toBe(true);
	});

	it("rejects an invalid extended regular expression with a typed validation error", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		await expect(new LocalGit(repoRoot).grepHistory("(", undefined, BOUNDS)).rejects.toBeInstanceOf(InvalidGitSearchPattern);
	});

	it("returns an explicit partial outcome when its deadline expires", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		const result = await new LocalGit(repoRoot).grepHistory("needle", undefined, { ...BOUNDS, deadlineMs: 1 });
		expect(result.deadlineReached).toBe(true);
	});

	it("honors an already-aborted caller signal", async () => {
		const fixture = buildHistory();
		repoRoot = fixture.root;
		const controller = new AbortController();
		controller.abort(new DOMException("cancelled", "AbortError"));

		await expect(new LocalGit(repoRoot).grepHistory("needle", undefined, BOUNDS, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	});
});
