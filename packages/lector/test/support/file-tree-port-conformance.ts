/**
 * Shared conformance suite for any FileTreePort implementation. Every adapter (InMemoryWorkspace,
 * LocalFilesystemWorkspace, and any future one) must pass this unmodified.
 *
 * Deliberately does not assert an ordering from listDirectory itself -- sorting (directories
 * before files, then alphabetical) is domain policy (see domain/list-directory.ts), not a port
 * contract every adapter must independently reproduce.
 */
import { describe, expect, it } from "bun:test";
import type { FileTreeEntry, FileTreePort } from "../../src/ports/file-tree-port.ts";

export interface FileTreeConformanceHarness {
	/** Fresh, empty tree for one test, plus a way to create a plain file at a path (WorkspacePort.writeEntry in production, a bare helper here since not every harness wants to construct a whole WorkspacePort). */
	create(): Promise<{ fileTree: FileTreePort; writeFile: (path: string, content: string) => Promise<void> }>;
	cleanup?(fileTree: FileTreePort): void | Promise<void>;
}

function byName(entries: readonly FileTreeEntry[]): FileTreeEntry[] {
	return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

export function runFileTreePortConformanceSuite(name: string, harness: FileTreeConformanceHarness): void {
	async function withFileTree<T>(fn: (fileTree: FileTreePort, writeFile: (path: string, content: string) => Promise<void>) => Promise<T>): Promise<T> {
		const { fileTree, writeFile } = await harness.create();
		try {
			return await fn(fileTree, writeFile);
		} finally {
			await harness.cleanup?.(fileTree);
		}
	}

	describe(`FileTreePort conformance: ${name}`, () => {
		describe("listDirectory", () => {
			it("returns an empty array for a directory with no children", () =>
				withFileTree(async (fileTree) => {
					await fileTree.createDirectory("empty");
					expect(await fileTree.listDirectory("empty")).toEqual([]);
				}));

			it("lists an immediate child directory created via createDirectory", () =>
				withFileTree(async (fileTree) => {
					await fileTree.createDirectory("src");
					expect(await fileTree.listDirectory("")).toEqual([{ name: "src", kind: "directory" }]);
				}));

			it("lists a plain file alongside a directory, each with its own kind", () =>
				withFileTree(async (fileTree, writeFile) => {
					await fileTree.createDirectory("src");
					await writeFile("readme.md", "hello");
					expect(byName(await fileTree.listDirectory(""))).toEqual([
						{ name: "readme.md", kind: "file" },
						{ name: "src", kind: "directory" },
					]);
				}));

			it("never descends past the immediate children -- a nested grandchild is not listed", () =>
				withFileTree(async (fileTree) => {
					await fileTree.createDirectory("a/b/c");
					expect(await fileTree.listDirectory("")).toEqual([{ name: "a", kind: "directory" }]);
					expect(await fileTree.listDirectory("a")).toEqual([{ name: "b", kind: "directory" }]);
				}));
		});

		describe("createDirectory", () => {
			it("creates every missing intermediate directory (mkdir -p)", () =>
				withFileTree(async (fileTree) => {
					await fileTree.createDirectory("a/b/c");
					expect(await fileTree.listDirectory("a")).toEqual([{ name: "b", kind: "directory" }]);
					expect(await fileTree.listDirectory("a/b")).toEqual([{ name: "c", kind: "directory" }]);
				}));

			it("is a no-op when the directory already exists", () =>
				withFileTree(async (fileTree) => {
					await fileTree.createDirectory("src");
					await fileTree.createDirectory("src");
					expect(await fileTree.listDirectory("")).toEqual([{ name: "src", kind: "directory" }]);
				}));
		});

		describe("renamePath", () => {
			it("moves a directory to a new name, preserving its children", () =>
				withFileTree(async (fileTree) => {
					await fileTree.createDirectory("old/inner");
					await fileTree.renamePath("old", "new");
					expect(await fileTree.listDirectory("")).toEqual([{ name: "new", kind: "directory" }]);
					expect(await fileTree.listDirectory("new")).toEqual([{ name: "inner", kind: "directory" }]);
				}));

			it("moves a plain file to a new name, preserving its content", () =>
				withFileTree(async (fileTree, writeFile) => {
					await writeFile("old.txt", "hello");
					await fileTree.renamePath("old.txt", "new.txt");
					expect(await fileTree.listDirectory("")).toEqual([{ name: "new.txt", kind: "file" }]);
				}));

			it("rejects when the destination already exists", () =>
				withFileTree(async (fileTree) => {
					await fileTree.createDirectory("a");
					await fileTree.createDirectory("b");
					await expect(fileTree.renamePath("a", "b")).rejects.toThrow();
				}));
		});

		describe("deleteDirectory", () => {
			it("removes a directory and everything nested under it", () =>
				withFileTree(async (fileTree) => {
					await fileTree.createDirectory("doomed/nested");
					await fileTree.deleteDirectory("doomed");
					expect(await fileTree.listDirectory("")).toEqual([]);
				}));

			it("removes an already-empty directory without error", () =>
				withFileTree(async (fileTree) => {
					await fileTree.createDirectory("empty");
					await fileTree.deleteDirectory("empty");
					expect(await fileTree.listDirectory("")).toEqual([]);
				}));
		});
	});
}
