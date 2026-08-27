/**
 * Behavioral tests for runExplorerFlow's own orchestration -- the browse/open/return-to-directory
 * loop -- against fake showExplorer/showEditor hosts, never a real UI or daemon.
 */
import { describe, expect, it } from "bun:test";
import type { DirectoryExplorerSession } from "../../extension/src/editor/directory-explorer-operations.ts";
import type { ExplorerResult } from "../../extension/src/editor/explorer-component.ts";
import type { ExplorerFlowHost } from "../../extension/src/editor/explorer-flow.ts";
import { runExplorerFlow } from "../../extension/src/editor/explorer-flow.ts";

function fakeSession(root: string): DirectoryExplorerSession {
	return {
		root,
		workspaceId: "ws" as never,
		listDirectory: async () => ({ path: "", entries: [] }),
		createFile: async () => undefined,
		createDirectory: async () => undefined,
		renamePath: async () => undefined,
		deleteFile: async () => undefined,
		deleteDirectory: async () => undefined,
	};
}

describe("runExplorerFlow", () => {
	it("quitting the explorer immediately never opens an editor", async () => {
		const session = fakeSession("/repo");
		const editorCalls: string[] = [];
		const host: ExplorerFlowHost = {
			showExplorer: async () => ({ kind: "quit" }),
			showEditor: async (path) => {
				editorCalls.push(path);
			},
		};
		await runExplorerFlow(session, host);
		expect(editorCalls).toEqual([]);
	});

	it("opens a file at the resolved root, then returns to the explorer at the root ('')", async () => {
		const session = fakeSession("/repo");
		const explorerCalls: string[] = [];
		let call = 0;
		const host: ExplorerFlowHost = {
			showExplorer: async (_session, relativePath): Promise<ExplorerResult> => {
				explorerCalls.push(relativePath);
				call++;
				return call === 1 ? { kind: "open-file", absolutePath: "/repo/readme.md" } : { kind: "quit" };
			},
			showEditor: async () => undefined,
		};
		await runExplorerFlow(session, host);
		expect(explorerCalls).toEqual(["", ""]);
	});

	it("opens a file in a subdirectory, then returns to the explorer at that subdirectory", async () => {
		const session = fakeSession("/repo");
		const explorerCalls: string[] = [];
		let call = 0;
		const host: ExplorerFlowHost = {
			showExplorer: async (_session, relativePath): Promise<ExplorerResult> => {
				explorerCalls.push(relativePath);
				call++;
				return call === 1 ? { kind: "open-file", absolutePath: "/repo/src/index.ts" } : { kind: "quit" };
			},
			showEditor: async () => undefined,
		};
		await runExplorerFlow(session, host);
		expect(explorerCalls).toEqual(["", "src"]);
	});

	it("returns to the edited file and exposes the final Workspace view state", async () => {
		const session = fakeSession("/repo");
		const explorerCalls: Array<{ relativePath: string; selectedEntryName: string | undefined }> = [];
		let call = 0;
		const host: ExplorerFlowHost = {
			showExplorer: async (_session, relativePath, selectedEntryName): Promise<ExplorerResult> => {
				explorerCalls.push({ relativePath, selectedEntryName });
				call++;
				return call === 1 ? { kind: "open-file", absolutePath: "/repo/src/index.ts" } : { kind: "quit" };
			},
			showEditor: async () => undefined,
		};
		const finalState = await runExplorerFlow(session, host);
		expect(explorerCalls).toEqual([
			{ relativePath: "", selectedEntryName: undefined },
			{ relativePath: "src", selectedEntryName: "index.ts" },
		]);
		expect(finalState).toEqual({ relativePath: "src", selectedEntryName: "index.ts" });
	});

	it("calls showEditor with the real absolute path before returning to the explorer", async () => {
		const session = fakeSession("/repo");
		const editorCalls: string[] = [];
		let call = 0;
		const host: ExplorerFlowHost = {
			showExplorer: async (): Promise<ExplorerResult> => {
				call++;
				return call === 1 ? { kind: "open-file", absolutePath: "/repo/src/index.ts" } : { kind: "quit" };
			},
			showEditor: async (path) => {
				editorCalls.push(path);
			},
		};
		await runExplorerFlow(session, host);
		expect(editorCalls).toEqual(["/repo/src/index.ts"]);
	});

	it("opens multiple files across successive loop iterations, tracking the directory across each", async () => {
		const session = fakeSession("/repo");
		const explorerCalls: string[] = [];
		const editorCalls: string[] = [];
		let call = 0;
		const host: ExplorerFlowHost = {
			showExplorer: async (_session, relativePath): Promise<ExplorerResult> => {
				explorerCalls.push(relativePath);
				call++;
				if (call === 1) return { kind: "open-file", absolutePath: "/repo/src/index.ts" };
				if (call === 2) return { kind: "open-file", absolutePath: "/repo/readme.md" };
				return { kind: "quit" };
			},
			showEditor: async (path) => {
				editorCalls.push(path);
			},
		};
		await runExplorerFlow(session, host);
		expect(explorerCalls).toEqual(["", "src", ""]);
		expect(editorCalls).toEqual(["/repo/src/index.ts", "/repo/readme.md"]);
	});
});
