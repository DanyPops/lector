/**
 * RipgrepTextSearch against a real fixture directory and a real `rg` process -- no mocked
 * ripgrep binary or hand-rolled matcher.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RipgrepTextSearch } from "../../src/adapters/ripgrep-text-search.ts";
import { UnsafeSearchQuery } from "../../src/domain/assert-safe-search-query.ts";

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-ripgrep-fixture-"));
	writeFileSync(join(root, "a.txt"), "hello world\nfoo bar\nhello again\n");
	writeFileSync(join(root, "b.txt"), "nothing here\nhello too\n");
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "node_modules", "ignored.txt"), "hello from node_modules\n");
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "config"), "hello from git internals\n");
	return root;
}

describe("RipgrepTextSearch", () => {
	it("finds real matches across multiple files with line numbers and match spans", async () => {
		const root = buildFixture();
		try {
			const result = await new RipgrepTextSearch().search(root, "hello", { maxMatches: 100, maxBytes: 100_000 });

			expect(result.truncated).toBe(false);
			expect(result.matches).toContainEqual({ path: "a.txt", lineNumber: 1, line: "hello world\n", matchStart: 0, matchEnd: 5 });
			expect(result.matches).toContainEqual({ path: "a.txt", lineNumber: 3, line: "hello again\n", matchStart: 0, matchEnd: 5 });
			expect(result.matches).toContainEqual({ path: "b.txt", lineNumber: 2, line: "hello too\n", matchStart: 0, matchEnd: 5 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not search node_modules or .git -- .git via ripgrep's own hidden-directory default, node_modules via this adapter's explicit glob (verified empirically: rg alone does not skip it without a real .gitignore)", async () => {
		const root = buildFixture();
		try {
			const result = await new RipgrepTextSearch().search(root, "hello", { maxMatches: 100, maxBytes: 100_000 });
			expect(result.matches.every((match) => !match.path.includes("node_modules") && !match.path.includes(".git"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns an empty, non-truncated result for a query matching nothing", async () => {
		const root = buildFixture();
		try {
			const result = await new RipgrepTextSearch().search(root, "does-not-exist-anywhere", { maxMatches: 100, maxBytes: 100_000 });
			expect(result).toEqual({ matches: [], truncated: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("truncates at maxMatches and kills the process rather than scanning to completion", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-ripgrep-fixture-"));
		try {
			writeFileSync(join(root, "many.txt"), Array.from({ length: 50 }, () => "hello\n").join(""));
			const result = await new RipgrepTextSearch().search(root, "hello", { maxMatches: 5, maxBytes: 100_000 });

			expect(result.truncated).toBe(true);
			expect(result.matches.length).toBe(5);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("truncates at maxBytes even under a generous maxMatches", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-ripgrep-fixture-"));
		try {
			writeFileSync(join(root, "many.txt"), Array.from({ length: 50 }, () => "hello world this is a longer line\n").join(""));
			const result = await new RipgrepTextSearch().search(root, "hello", { maxMatches: 1000, maxBytes: 200 });

			expect(result.truncated).toBe(true);
			expect(result.matches.length).toBeLessThan(50);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a query that looks like a ripgrep flag before spawning", async () => {
		const root = buildFixture();
		try {
			await expect(new RipgrepTextSearch().search(root, "--max-count=1", { maxMatches: 100, maxBytes: 1000 })).rejects.toBeInstanceOf(UnsafeSearchQuery);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces a real ripgrep error (invalid regex) as a rejection, not a silently empty result", async () => {
		const root = buildFixture();
		try {
			await expect(new RipgrepTextSearch().search(root, "(unterminated[", { maxMatches: 100, maxBytes: 1000 })).rejects.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
