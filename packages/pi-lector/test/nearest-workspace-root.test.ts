/**
 * Root cause fix for a real, shipped bug (discovered live): read/write/edit
 * were hard-locked to a Pi session's original cwd as the one-and-only
 * Lector workspace root, refusing every legitimate absolute path outside
 * it. nearestGitRoot is the actual boundary Lector should use instead --
 * per project (repo), resolved from whatever path is actually being
 * touched, never from a fixed session-wide value.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nearestGitRoot } from "../extension/src/nearest-workspace-root.ts";

describe("nearestGitRoot", () => {
	it("finds a git root several directories above the starting point", () => {
		const root = mkdtempSync(join(tmpdir(), "nearest-git-root-"));
		try {
			mkdirSync(join(root, ".git"));
			const deep = join(root, "src", "adapters", "lsp");
			mkdirSync(deep, { recursive: true });

			expect(nearestGitRoot(deep)).toBe(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns the starting directory itself when it directly contains .git", () => {
		const root = mkdtempSync(join(tmpdir(), "nearest-git-root-self-"));
		try {
			mkdirSync(join(root, ".git"));
			expect(nearestGitRoot(root)).toBe(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("finds the nearest repo, not an outer one, when repos are nested", () => {
		const outer = mkdtempSync(join(tmpdir(), "nearest-git-root-outer-"));
		try {
			mkdirSync(join(outer, ".git"));
			const inner = join(outer, "vendor", "nested-repo");
			mkdirSync(join(inner, ".git"), { recursive: true });
			const deepInInner = join(inner, "src");
			mkdirSync(deepInInner);

			expect(nearestGitRoot(deepInInner)).toBe(inner);
		} finally {
			rmSync(outer, { recursive: true, force: true });
		}
	});

	it("returns undefined when no enclosing .git exists anywhere -- callers choose their own fallback", () => {
		const root = mkdtempSync(join(tmpdir(), "nearest-git-root-none-"));
		try {
			// A plain tmp directory with no .git anywhere in its ancestry (true for /tmp itself).
			expect(nearestGitRoot(root)).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
