/**
 * findFiles' own validation, against a real RipgrepTextSearch -- the counting wrapper below
 * only counts calls and forwards them to the real adapter, it never fakes a result.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnsafeGlobPattern } from "../../src/domain/assert-safe-glob-pattern.ts";
import { findFiles } from "../../src/text-search/find-files.ts";
import { RipgrepTextSearch } from "../../src/text-search/ripgrep-text-search.ts";

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-find-files-fixture-"));
	writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(root, "b.md"), "# doc\n");
	return root;
}

describe("findFiles", () => {
	it("lists real files matching a glob, delegating to the real port", async () => {
		const root = buildFixture();
		try {
			const result = await findFiles(new RipgrepTextSearch(), root, ["*.ts"], { maxResults: 100, maxBytes: 100_000 });
			expect(result).toEqual({ paths: ["a.ts"], truncated: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects zero patterns rather than listing the whole tree unbounded", async () => {
		const root = buildFixture();
		try {
			await expect(findFiles(new RipgrepTextSearch(), root, [], { maxResults: 100, maxBytes: 100_000 })).rejects.toBeInstanceOf(TypeError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an unsafe pattern before ever touching the port", async () => {
		const root = buildFixture();
		try {
			await expect(findFiles(new RipgrepTextSearch(), root, ["--exec=rm"], { maxResults: 100, maxBytes: 100_000 })).rejects.toBeInstanceOf(UnsafeGlobPattern);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
