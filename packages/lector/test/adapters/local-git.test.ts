/**
 * LocalGit against a real git repository -- real init, real commits, real
 * status/log/diff via simple-git, not a mocked git binary.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGit } from "../../src/adapters/local-git.ts";
import { UnsafeGitArgument } from "../../src/domain/assert-safe-git-argument.ts";

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
});
