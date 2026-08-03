/**
 * Ports oil.nvim's own lua/oil/mutator/parser.lua diff algorithm: a directory listing becomes a
 * list of lines, each existing entry prefixed with a stable "<id> " tag; editing that tag's own
 * name is a rename (matched by id, never by line position), removing a tagged line is a delete,
 * and a line with no id tag at all is a brand-new entry.
 */
import { describe, expect, it } from "bun:test";
import type { ExplorerEntry } from "../../extension/src/editor/explorer-diff.ts";
import { diffExplorerLines, formatExplorerLine, parseExplorerLine } from "../../extension/src/editor/explorer-diff.ts";

describe("formatExplorerLine", () => {
	it("renders a file entry as '<id> name'", () => {
		expect(formatExplorerLine({ id: 3, name: "readme.md", kind: "file" })).toBe("3 readme.md");
	});

	it("renders a directory entry with a trailing slash", () => {
		expect(formatExplorerLine({ id: 7, name: "src", kind: "directory" })).toBe("7 src/");
	});
});

describe("parseExplorerLine", () => {
	it("parses an existing entry line back into its id and name", () => {
		expect(parseExplorerLine("3 readme.md")).toEqual({ id: 3, name: "readme.md", isDirectory: false });
	});

	it("parses a directory line, stripping the trailing slash", () => {
		expect(parseExplorerLine("7 src/")).toEqual({ id: 7, name: "src", isDirectory: true });
	});

	it("parses a line with no id prefix as a brand-new entry", () => {
		expect(parseExplorerLine("new-file.txt")).toEqual({ id: null, name: "new-file.txt", isDirectory: false });
	});

	it("parses a new directory entry (trailing slash, no id)", () => {
		expect(parseExplorerLine("new-dir/")).toEqual({ id: null, name: "new-dir", isDirectory: true });
	});

	it("returns null for a blank line -- ignored, not a new entry named ''", () => {
		expect(parseExplorerLine("   ")).toBeNull();
	});

	it("trims surrounding whitespace from the name", () => {
		expect(parseExplorerLine("3   readme.md  ")).toEqual({ id: 3, name: "readme.md", isDirectory: false });
	});
});

describe("diffExplorerLines", () => {
	const original: ExplorerEntry[] = [
		{ id: 1, name: "readme.md", kind: "file" },
		{ id: 2, name: "src", kind: "directory" },
	];

	it("produces no diffs when every line is unchanged", () => {
		const diffs = diffExplorerLines(original, ["1 readme.md", "2 src/"]);
		expect(diffs).toEqual([]);
	});

	it("detects a rename when an id-tagged line's name changed", () => {
		const diffs = diffExplorerLines(original, ["1 README.md", "2 src/"]);
		expect(diffs).toEqual([{ kind: "rename", id: 1, fromName: "readme.md", toName: "README.md" }]);
	});

	it("detects a delete when an id-tagged line is removed entirely", () => {
		const diffs = diffExplorerLines(original, ["1 readme.md"]);
		expect(diffs).toEqual([{ kind: "delete", id: 2, name: "src", isDirectory: true }]);
	});

	it("detects a create for a line with no id tag", () => {
		const diffs = diffExplorerLines(original, ["1 readme.md", "2 src/", "new-file.txt"]);
		expect(diffs).toEqual([{ kind: "create", name: "new-file.txt", isDirectory: false }]);
	});

	it("detects a create for a new directory (trailing slash)", () => {
		const diffs = diffExplorerLines(original, ["1 readme.md", "2 src/", "docs/"]);
		expect(diffs).toEqual([{ kind: "create", name: "docs", isDirectory: true }]);
	});

	it("combines a rename, a delete, and a create from one edit pass -- renames/creates in line order, deletes (computed after the scan) last", () => {
		const diffs = diffExplorerLines(original, ["1 README.md", "new-file.txt"]);
		expect(diffs).toEqual([
			{ kind: "rename", id: 1, fromName: "readme.md", toName: "README.md" },
			{ kind: "create", name: "new-file.txt", isDirectory: false },
			{ kind: "delete", id: 2, name: "src", isDirectory: true },
		]);
	});

	it("ignores blank lines entirely -- neither a delete nor a create", () => {
		const diffs = diffExplorerLines(original, ["1 readme.md", "", "2 src/", "   "]);
		expect(diffs).toEqual([]);
	});

	it("treats renaming a directory's own line the same way as a file rename", () => {
		const diffs = diffExplorerLines(original, ["1 readme.md", "2 lib/"]);
		expect(diffs).toEqual([{ kind: "rename", id: 2, fromName: "src", toName: "lib" }]);
	});
});
