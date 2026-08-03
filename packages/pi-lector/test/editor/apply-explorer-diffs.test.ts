import { describe, expect, it } from "bun:test";
import { applyExplorerDiffs, summarizeExplorerDiff } from "../../extension/src/editor/apply-explorer-diffs.ts";
import type { ExplorerDiff } from "../../extension/src/editor/explorer-diff.ts";

function fakeSession() {
	const calls: string[] = [];
	return {
		calls,
		session: {
			root: "/repo",
			workspaceId: "ws" as never,
			listDirectory: async () => ({ path: "", entries: [] }),
			createFile: async (path: string) => {
				calls.push(`createFile ${path}`);
			},
			createDirectory: async (path: string) => {
				calls.push(`createDirectory ${path}`);
			},
			renamePath: async (from: string, to: string) => {
				calls.push(`renamePath ${from} -> ${to}`);
			},
			deleteFile: async (path: string) => {
				calls.push(`deleteFile ${path}`);
			},
			deleteDirectory: async (path: string) => {
				calls.push(`deleteDirectory ${path}`);
			},
		},
	};
}

describe("applyExplorerDiffs", () => {
	it("creates a file at the current directory-relative path", async () => {
		const { session, calls } = fakeSession();
		await applyExplorerDiffs(session, "src", [{ kind: "create", name: "new.ts", isDirectory: false }]);
		expect(calls).toEqual(["createFile src/new.ts"]);
	});

	it("creates a directory at the current directory-relative path", async () => {
		const { session, calls } = fakeSession();
		await applyExplorerDiffs(session, "src", [{ kind: "create", name: "nested", isDirectory: true }]);
		expect(calls).toEqual(["createDirectory src/nested"]);
	});

	it("joins the root directory ('') without a leading slash", async () => {
		const { session, calls } = fakeSession();
		await applyExplorerDiffs(session, "", [{ kind: "create", name: "readme.md", isDirectory: false }]);
		expect(calls).toEqual(["createFile readme.md"]);
	});

	it("renames within the current directory", async () => {
		const { session, calls } = fakeSession();
		await applyExplorerDiffs(session, "src", [{ kind: "rename", id: 1, fromName: "old.ts", toName: "new.ts" }]);
		expect(calls).toEqual(["renamePath src/old.ts -> src/new.ts"]);
	});

	it("deletes a file vs. a directory through the right session method", async () => {
		const { session, calls } = fakeSession();
		await applyExplorerDiffs(session, "", [
			{ kind: "delete", id: 1, name: "readme.md", isDirectory: false },
			{ kind: "delete", id: 2, name: "old-dir", isDirectory: true },
		]);
		expect(calls).toEqual(["deleteFile readme.md", "deleteDirectory old-dir"]);
	});

	it("applies diffs in the order given", async () => {
		const { session, calls } = fakeSession();
		const diffs: ExplorerDiff[] = [
			{ kind: "rename", id: 1, fromName: "a.ts", toName: "b.ts" },
			{ kind: "create", name: "c.ts", isDirectory: false },
			{ kind: "delete", id: 2, name: "d.ts", isDirectory: false },
		];
		await applyExplorerDiffs(session, "", diffs);
		expect(calls).toEqual(["renamePath a.ts -> b.ts", "createFile c.ts", "deleteFile d.ts"]);
	});
});

describe("summarizeExplorerDiff", () => {
	it("summarizes a file create", () => {
		expect(summarizeExplorerDiff({ kind: "create", name: "new.ts", isDirectory: false })).toBe("+ new.ts");
	});

	it("summarizes a directory create with a trailing slash", () => {
		expect(summarizeExplorerDiff({ kind: "create", name: "nested", isDirectory: true })).toBe("+ nested/");
	});

	it("summarizes a rename", () => {
		expect(summarizeExplorerDiff({ kind: "rename", id: 1, fromName: "old.ts", toName: "new.ts" })).toBe("old.ts -> new.ts");
	});

	it("summarizes a delete", () => {
		expect(summarizeExplorerDiff({ kind: "delete", id: 1, name: "old.ts", isDirectory: false })).toBe("- old.ts");
	});

	it("summarizes a directory delete with a trailing slash", () => {
		expect(summarizeExplorerDiff({ kind: "delete", id: 1, name: "old-dir", isDirectory: true })).toBe("- old-dir/");
	});
});
