import { describe, expect, it } from "bun:test";
import type { FileTreeEntry, FileTreePort } from "../../src/workspace/file-tree-port.ts";
import { listDirectory } from "../../src/workspace/list-directory.ts";

function fakeFileTree(entries: FileTreeEntry[]): FileTreePort {
	return {
		listDirectory: async () => entries,
		createDirectory: async () => undefined,
		renamePath: async () => undefined,
		deleteDirectory: async () => undefined,
	};
}

describe("listDirectory", () => {
	it("sorts directories before files", async () => {
		const listing = await listDirectory(
			fakeFileTree([
				{ name: "readme.md", kind: "file" },
				{ name: "src", kind: "directory" },
			]),
			"",
		);
		expect(listing.entries.map((entry) => entry.name)).toEqual(["src", "readme.md"]);
	});

	it("sorts alphabetically within the same kind", async () => {
		const listing = await listDirectory(
			fakeFileTree([
				{ name: "zebra.ts", kind: "file" },
				{ name: "apple.ts", kind: "file" },
				{ name: "mango", kind: "directory" },
				{ name: "banana", kind: "directory" },
			]),
			"",
		);
		expect(listing.entries.map((entry) => entry.name)).toEqual(["banana", "mango", "apple.ts", "zebra.ts"]);
	});

	it("treats a symlink as sorting alongside files, not directories", async () => {
		const listing = await listDirectory(
			fakeFileTree([
				{ name: "link", kind: "symlink" },
				{ name: "dir", kind: "directory" },
			]),
			"",
		);
		expect(listing.entries.map((entry) => entry.name)).toEqual(["dir", "link"]);
	});

	it("carries the requested path through to the result", async () => {
		const listing = await listDirectory(fakeFileTree([]), "src/adapters");
		expect(listing.path).toBe("src/adapters");
	});

	it("returns an empty entries array for an empty directory, not an error", async () => {
		const listing = await listDirectory(fakeFileTree([]), "");
		expect(listing.entries).toEqual([]);
	});
});
