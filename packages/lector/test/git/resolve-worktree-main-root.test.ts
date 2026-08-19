import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorktreeMainRoot } from "../../src/git/resolve-worktree-main-root.ts";

let repoRoot: string | undefined;
let worktreeDir: string | undefined;

afterEach(() => {
	if (worktreeDir) rmSync(worktreeDir, { recursive: true, force: true });
	worktreeDir = undefined;
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
	repoRoot = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-worktree-main-root-fixture-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "a.txt"), "hello\n");
	git(root, "add", "a.txt");
	git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

describe("resolveWorktreeMainRoot", () => {
	it("resolves a real linked worktree's own main repository root", async () => {
		repoRoot = buildRepo();
		worktreeDir = join(tmpdir(), `lector-worktree-main-root-wt-${Date.now()}`);
		git(repoRoot, "worktree", "add", "--detach", worktreeDir, "HEAD");

		const mainRoot = await resolveWorktreeMainRoot(worktreeDir);

		// Compare via a real filesystem identity check (execFileSync realpath), not raw string
		// equality -- tmpdir() itself may be a symlink (e.g. macOS's /tmp -> /private/tmp).
		const expected = execFileSync("realpath", [repoRoot]).toString().trim();
		const actual = mainRoot ? execFileSync("realpath", [mainRoot]).toString().trim() : undefined;
		expect(actual).toBe(expected);
	});

	it("returns undefined for a real repository's own main root (not a linked worktree)", async () => {
		repoRoot = buildRepo();
		expect(await resolveWorktreeMainRoot(repoRoot)).toBeUndefined();
	});

	it("returns undefined for a plain, non-git directory", async () => {
		const plain = mkdtempSync(join(tmpdir(), "lector-worktree-main-root-plain-"));
		try {
			expect(await resolveWorktreeMainRoot(plain)).toBeUndefined();
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("returns undefined for a path that does not exist", async () => {
		expect(await resolveWorktreeMainRoot(join(tmpdir(), "lector-worktree-main-root-missing"))).toBeUndefined();
	});
});
