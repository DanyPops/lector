/**
 * Root cause fix for a real, shipped bug (discovered live): read/write/edit
 * were hard-locked to a Pi session's original cwd as the one-and-only
 * Lector workspace root, refusing every legitimate absolute path outside
 * it. nearestGitRoot is the actual boundary Lector should use instead --
 * per project (repo), resolved from whatever path is actually being
 * touched, never from a fixed session-wide value.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nearestGitRoot, nearestProjectRoot } from "../extension/src/nearest-workspace-root.ts";

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

describe("nearestProjectRoot", () => {
	it("prefers a monorepo subproject's own root marker over the outer repo's .git", () => {
		const repo = mkdtempSync(join(tmpdir(), "nearest-project-root-monorepo-"));
		try {
			mkdirSync(join(repo, ".git"));
			const subproject = join(repo, "packages", "app");
			mkdirSync(subproject, { recursive: true });
			writeFileSync(join(subproject, "tsconfig.json"), "{}");
			const deep = join(subproject, "src");
			mkdirSync(deep);

			expect(nearestProjectRoot(deep, ["tsconfig.json", "package.json"])).toBe(subproject);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("falls back to the nearest .git when no closer root marker exists", () => {
		const repo = mkdtempSync(join(tmpdir(), "nearest-project-root-fallback-"));
		try {
			mkdirSync(join(repo, ".git"));
			const deep = join(repo, "src", "lib");
			mkdirSync(deep, { recursive: true });

			expect(nearestProjectRoot(deep, ["go.mod"])).toBe(repo);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("checks every declared marker, not just the first, at each directory", () => {
		const repo = mkdtempSync(join(tmpdir(), "nearest-project-root-multi-marker-"));
		try {
			mkdirSync(join(repo, ".git"));
			const project = join(repo, "service");
			mkdirSync(project, { recursive: true });
			writeFileSync(join(project, "go.work"), "");
			const deep = join(project, "internal");
			mkdirSync(deep);

			expect(nearestProjectRoot(deep, ["go.mod", "go.work"])).toBe(project);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("returns undefined when neither a root marker nor .git exists anywhere", () => {
		const root = mkdtempSync(join(tmpdir(), "nearest-project-root-none-"));
		try {
			expect(nearestProjectRoot(root, ["Cargo.toml"])).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves exactly like nearestGitRoot when given no root markers", () => {
		const repo = mkdtempSync(join(tmpdir(), "nearest-project-root-no-markers-"));
		try {
			mkdirSync(join(repo, ".git"));
			const deep = join(repo, "src");
			mkdirSync(deep);

			expect(nearestProjectRoot(deep, [])).toBe(nearestGitRoot(deep));
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
