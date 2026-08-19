import { describe, expect, it } from "bun:test";
import { worktreePathFor } from "../../src/git/worktree-path.ts";

describe("worktreePathFor", () => {
	it("is deterministic for the same (worktreesRoot, repoRootPath, ref)", () => {
		const a = worktreePathFor("/data/worktrees", "/home/user/repo", "release-4.20");
		const b = worktreePathFor("/data/worktrees", "/home/user/repo", "release-4.20");
		expect(a).toBe(b);
	});

	it("differs for a different ref against the same repo", () => {
		const a = worktreePathFor("/data/worktrees", "/home/user/repo", "release-4.20");
		const b = worktreePathFor("/data/worktrees", "/home/user/repo", "release-4.22");
		expect(a).not.toBe(b);
	});

	it("differs for the same ref against a different repo", () => {
		const a = worktreePathFor("/data/worktrees", "/home/user/repo-one", "main");
		const b = worktreePathFor("/data/worktrees", "/home/user/repo-two", "main");
		expect(a).not.toBe(b);
	});

	it("sanitizes a ref containing path separators into one safe directory segment", () => {
		const path = worktreePathFor("/data/worktrees", "/home/user/repo", "feature/e825-holdover");
		expect(path.split("/").length).toBe(5); // "", "data", "worktrees", "<repoHash>", "<sanitizedRef>"
		expect(path).not.toContain("feature/e825-holdover");
	});
});
