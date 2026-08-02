import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSourceFiles } from "../../src/text-search/find-source-files.ts";

function withFixture(build: (root: string) => void, run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "lector-find-source-files-"));
	try {
		build(root);
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function write(root: string, relativePath: string, content = ""): void {
	const fullPath = join(root, relativePath);
	mkdirSync(join(fullPath, ".."), { recursive: true });
	writeFileSync(fullPath, content);
}

const IS_TS = (extension: string) => extension === ".ts";

describe("findSourceFiles", () => {
	it("finds files with a matching extension and skips everything else, deterministically sorted", () =>
		withFixture(
			(root) => {
				write(root, "b.ts");
				write(root, "a.ts");
				write(root, "readme.md");
			},
			(root) => {
				expect(findSourceFiles(root, IS_TS, 100)).toEqual(["a.ts", "b.ts"]);
			},
		));

	it("skips node_modules, .git, dist, build, and hidden directories -- unrelated to .gitignore entirely", () =>
		withFixture(
			(root) => {
				write(root, "kept.ts");
				write(root, "node_modules/pkg/index.ts");
				write(root, ".git/objects/x.ts");
				write(root, "dist/out.ts");
				write(root, ".hidden/x.ts");
			},
			(root) => {
				expect(findSourceFiles(root, IS_TS, 100)).toEqual(["kept.ts"]);
			},
		));

	it("respects a root .gitignore -- an excluded source file is never scanned at all", () =>
		withFixture(
			(root) => {
				write(root, "kept.ts");
				write(root, "generated.ts");
				write(root, ".gitignore", "generated.ts\n");
			},
			(root) => {
				expect(findSourceFiles(root, IS_TS, 100)).toEqual(["kept.ts"]);
			},
		));

	it("respects a root .gitignore wildcard pattern matching at any depth", () =>
		withFixture(
			(root) => {
				write(root, "src/a.ts");
				write(root, "src/a.generated.ts");
				write(root, "lib/b.generated.ts");
				write(root, ".gitignore", "*.generated.ts\n");
			},
			(root) => {
				expect(findSourceFiles(root, IS_TS, 100).sort()).toEqual([join("src", "a.ts")]);
			},
		));

	it("respects a nested .gitignore, scoped only to its own subtree", () =>
		withFixture(
			(root) => {
				write(root, "kept.ts");
				write(root, "sub/kept.ts");
				write(root, "sub/excluded.ts");
				write(root, "sub/.gitignore", "excluded.ts\n");
				// A sibling directory's identically-named file is NOT covered by sub/.gitignore.
				write(root, "other/excluded.ts");
			},
			(root) => {
				expect(findSourceFiles(root, IS_TS, 100).sort()).toEqual([join("kept.ts"), join("other", "excluded.ts"), join("sub", "kept.ts")].sort());
			},
		));

	it("respects an unanchored nested-.gitignore pattern matching at any depth under its own directory", () =>
		withFixture(
			(root) => {
				write(root, "sub/a.log.ts");
				write(root, "sub/deeper/b.log.ts");
				write(root, "sub/.gitignore", "*.log.ts\n");
			},
			(root) => {
				expect(findSourceFiles(root, IS_TS, 100)).toEqual([]);
			},
		));

	it("respects an anchored nested-.gitignore pattern -- only matches directly inside its own directory, not deeper", () =>
		withFixture(
			(root) => {
				write(root, "sub/build.ts");
				write(root, "sub/deeper/build.ts");
				write(root, "sub/.gitignore", "/build.ts\n");
			},
			(root) => {
				expect(findSourceFiles(root, IS_TS, 100)).toEqual([join("sub", "deeper", "build.ts")]);
			},
		));

	it("respects a negation pattern re-including a file otherwise excluded by a broader pattern", () =>
		withFixture(
			(root) => {
				write(root, "a.log.ts");
				write(root, "important.log.ts");
				write(root, ".gitignore", "*.log.ts\n!important.log.ts\n");
			},
			(root) => {
				expect(findSourceFiles(root, IS_TS, 100)).toEqual(["important.log.ts"]);
			},
		));

	it("ignores comment and blank lines in a .gitignore instead of treating them as patterns", () =>
		withFixture(
			(root) => {
				write(root, "kept.ts");
				write(root, ".gitignore", "# a comment\n\n   \n");
			},
			(root) => {
				expect(findSourceFiles(root, IS_TS, 100)).toEqual(["kept.ts"]);
			},
		));

	it("behaves exactly as before when no .gitignore exists anywhere in the tree", () =>
		withFixture(
			(root) => {
				write(root, "a.ts");
				write(root, "sub/b.ts");
			},
			(root) => {
				expect(findSourceFiles(root, IS_TS, 100).sort()).toEqual([join("a.ts"), join("sub", "b.ts")].sort());
			},
		));

	it("still enforces maxFiles when a .gitignore is also present", () =>
		withFixture(
			(root) => {
				write(root, "a.ts");
				write(root, "b.ts");
				write(root, "c.ts");
				write(root, ".gitignore", "generated.ts\n");
			},
			(root) => {
				expect(findSourceFiles(root, IS_TS, 2).length).toBe(2);
			},
		));
});
