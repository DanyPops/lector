import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { resolveWorkspacePath } from "../../src/workspace/resolve-workspace-path.ts";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("resolveWorkspacePath -- git-root", () => {
	it("finds the nearest enclosing git root", () => {
		const root = tempDir("resolve-git-root-");
		try {
			mkdirSync(join(root, ".git"));
			const deep = join(root, "src", "lib");
			mkdirSync(deep, { recursive: true });

			expect(resolveWorkspacePath({ strategy: "git-root", path: deep, fallback: "given-directory" })).toEqual({ found: true, root });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to the filesystem root when no git repo exists and fallback is filesystem-root -- workspace.registerPath's own raw read/write/edit contract", () => {
		const scratch = tempDir("resolve-git-root-fallback-fs-");
		try {
			expect(resolveWorkspacePath({ strategy: "git-root", path: scratch, fallback: "filesystem-root" })).toEqual({
				found: true,
				root: parse(scratch).root,
			});
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("falls back to the given directory itself when no git repo exists and fallback is given-directory -- never widens a symbol-search scope to the whole filesystem", () => {
		const scratch = tempDir("resolve-git-root-fallback-dir-");
		try {
			expect(resolveWorkspacePath({ strategy: "git-root", path: scratch, fallback: "given-directory" })).toEqual({ found: true, root: scratch });
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("resolveWorkspacePath -- git-root, no fallback", () => {
	it("reports found: false, not a directory-itself fallback, when no fallback is given and no git repo exists -- session_start's own 'is this really a project' gate", () => {
		const scratch = tempDir("resolve-git-root-no-fallback-none-");
		try {
			expect(resolveWorkspacePath({ strategy: "git-root", path: scratch })).toEqual({ found: false });
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("still finds a real git root honestly when one exists, fallback or not", () => {
		const root = tempDir("resolve-git-root-no-fallback-found-");
		try {
			mkdirSync(join(root, ".git"));
			expect(resolveWorkspacePath({ strategy: "git-root", path: root })).toEqual({ found: true, root });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolveWorkspacePath -- language-project-root", () => {
	it("prefers a monorepo subproject's own root marker (by extension) over the outer repo's .git", () => {
		const repo = tempDir("resolve-lang-root-monorepo-");
		try {
			mkdirSync(join(repo, ".git"));
			const subproject = join(repo, "packages", "app");
			mkdirSync(subproject, { recursive: true });
			writeFileSync(join(subproject, "tsconfig.json"), "{}");
			const deep = join(subproject, "src");
			mkdirSync(deep);

			expect(resolveWorkspacePath({ strategy: "language-project-root", path: deep, fallback: "given-directory", extension: ".ts" })).toEqual({
				found: true,
				root: subproject,
			});
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("falls back to plain git-root behavior for an extension Lector doesn't know", () => {
		const repo = tempDir("resolve-lang-root-unknown-ext-");
		try {
			mkdirSync(join(repo, ".git"));
			const deep = join(repo, "src");
			mkdirSync(deep);

			expect(resolveWorkspacePath({ strategy: "language-project-root", path: deep, fallback: "given-directory", extension: ".xyz" })).toEqual({
				found: true,
				root: repo,
			});
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("checks every known language's markers unioned when no extension is given -- workspaceForProjectDirectory's own cross-project-comparison need", () => {
		const repo = tempDir("resolve-lang-root-union-");
		try {
			mkdirSync(join(repo, ".git"));
			const rustProject = join(repo, "worker");
			mkdirSync(rustProject, { recursive: true });
			writeFileSync(join(rustProject, "Cargo.toml"), "");
			const deep = join(rustProject, "src");
			mkdirSync(deep);

			expect(resolveWorkspacePath({ strategy: "language-project-root", path: deep, fallback: "given-directory" })).toEqual({
				found: true,
				root: rustProject,
			});
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("supports the filesystem-root fallback too, not just given-directory", () => {
		const scratch = tempDir("resolve-lang-root-fallback-fs-");
		try {
			expect(resolveWorkspacePath({ strategy: "language-project-root", path: scratch, fallback: "filesystem-root" })).toEqual({
				found: true,
				root: parse(scratch).root,
			});
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("resolveWorkspacePath -- declared-monorepo-root", () => {
	it("finds an ancestor whose package.json workspaces glob declares this project as a member", () => {
		const repo = tempDir("resolve-declared-root-");
		try {
			writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "repo", workspaces: ["packages/*"] }));
			const projectRoot = join(repo, "packages", "library");
			mkdirSync(projectRoot, { recursive: true });

			expect(resolveWorkspacePath({ strategy: "declared-monorepo-root", path: projectRoot })).toEqual({ found: true, root: repo });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("reports not found -- never a directory-itself/filesystem-root fallback -- for a plain single-package repo", () => {
		const repo = tempDir("resolve-declared-root-none-");
		try {
			writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "solo" }));
			const projectRoot = join(repo, "src");
			mkdirSync(projectRoot);

			expect(resolveWorkspacePath({ strategy: "declared-monorepo-root", path: projectRoot })).toEqual({ found: false });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("resolveWorkspacePath -- path-or-directory", () => {
	it("treats an already-real directory as the resolution start, not its parent -- the real, previously-shipped bug this fixes", () => {
		const repo = tempDir("resolve-path-or-dir-real-dir-");
		try {
			mkdirSync(join(repo, ".git"));
			const nested = join(repo, "packages", "app");
			mkdirSync(nested, { recursive: true });
			mkdirSync(join(nested, ".git"));

			expect(resolveWorkspacePath({ strategy: "path-or-directory", path: nested })).toEqual({ found: true, root: nested });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("takes dirname() first for a file or nonexistent path", () => {
		const repo = tempDir("resolve-path-or-dir-file-");
		try {
			mkdirSync(join(repo, ".git"));
			const file = join(repo, "src", "main.ts");
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "export {};\n");

			expect(resolveWorkspacePath({ strategy: "path-or-directory", path: file })).toEqual({ found: true, root: repo });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("never applies language markers -- a plain git-root walk only, matching workspaceForDirectory's own algorithm", () => {
		const repo = tempDir("resolve-path-or-dir-no-lang-markers-");
		try {
			mkdirSync(join(repo, ".git"));
			const rustProject = join(repo, "worker");
			mkdirSync(rustProject, { recursive: true });
			writeFileSync(join(rustProject, "Cargo.toml"), "");

			// A Cargo.toml alone (no .git of its own) must NOT stop the walk here -- only .git counts.
			expect(resolveWorkspacePath({ strategy: "path-or-directory", path: rustProject })).toEqual({ found: true, root: repo });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("falls back to the given directory itself, never the filesystem root, when no git repo exists anywhere", () => {
		const scratch = tempDir("resolve-path-or-dir-fallback-");
		try {
			expect(resolveWorkspacePath({ strategy: "path-or-directory", path: scratch })).toEqual({ found: true, root: scratch });
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("resolveWorkspacePath -- code-intelligence-path-or-directory", () => {
	it("resolves an existing project directory via language markers on itself, not its parent -- the real bug symbol-annotation hit", () => {
		const outer = tempDir("resolve-ci-path-or-dir-outer-");
		try {
			const project = join(outer, "packages", "app");
			mkdirSync(project, { recursive: true });
			writeFileSync(join(project, "package.json"), "{}");

			expect(resolveWorkspacePath({ strategy: "code-intelligence-path-or-directory", path: project })).toEqual({ found: true, root: project });
		} finally {
			rmSync(outer, { recursive: true, force: true });
		}
	});

	it("resolves an existing file via its own dirname()+extension language markers, matching workspaceForCodeIntelligencePath's per-file behavior", () => {
		const repo = tempDir("resolve-ci-path-or-dir-file-");
		try {
			writeFileSync(join(repo, "go.mod"), "module example\n");
			const nested = join(repo, "cmd", "main.go");
			mkdirSync(dirname(nested), { recursive: true });
			writeFileSync(nested, "package main\n");

			expect(resolveWorkspacePath({ strategy: "code-intelligence-path-or-directory", path: nested })).toEqual({ found: true, root: repo });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("reports a genuinely nonexistent path explicitly, never silently guessing file/directory semantics", () => {
		expect(resolveWorkspacePath({ strategy: "code-intelligence-path-or-directory", path: "/definitely/does/not/exist/at/all" })).toEqual({
			found: false,
			reason: "nonexistent-path",
		});
	});

	it("falls back to the directory itself when it exists but has no known language marker anywhere above it", () => {
		const scratch = tempDir("resolve-ci-path-or-dir-fallback-");
		try {
			expect(resolveWorkspacePath({ strategy: "code-intelligence-path-or-directory", path: scratch })).toEqual({ found: true, root: scratch });
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
