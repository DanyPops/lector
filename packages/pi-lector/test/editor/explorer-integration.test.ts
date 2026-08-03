/**
 * End-to-end integration coverage for the /editor-with-no-path flow against a real, isolated
 * Lector daemon and a real directory on disk -- distinct from explorer-flow.test.ts (pure
 * orchestration logic against a fake host) and explorer-component.test.ts (component behavior
 * against a fake session). Neither of those exercises the real RPC wiring this test proves:
 * openDirectoryExplorer's real workspace.listDirectory calls, and openEditorFile's real
 * workspace.rawRead, actually round-tripping through a running daemon.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDirectoryExplorer } from "../../extension/src/editor/directory-explorer-operations.ts";
import type { ExplorerResult } from "../../extension/src/editor/explorer-component.ts";
import { runExplorerFlow } from "../../extension/src/editor/explorer-flow.ts";
import { openEditorFile } from "../../extension/src/editor/operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

let repoRoot: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
	repoRoot = undefined;
});

function fakeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-explorer-integration-"));
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "readme.md"), "hello\n");
	writeFileSync(join(root, "src", "index.ts"), "export {};\n");
	return root;
}

describe("/editor with no path -- real explorer + editor round trip", () => {
	it("lists a real directory, opens a real nested file into the editor, and returns to that file's own directory", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		repoRoot = fakeRepo();

		const session = await openDirectoryExplorer(repoRoot);
		expect(session.root).toBe(repoRoot);

		const rootListing = await session.listDirectory("");
		expect(rootListing.entries.map((e) => e.name).sort()).toEqual(["readme.md", "src"]);

		const srcListing = await session.listDirectory("src");
		expect(srcListing.entries.map((e) => e.name)).toEqual(["index.ts"]);

		const explorerCalls: string[] = [];
		const openedFiles: { path: string; content: string }[] = [];
		let call = 0;
		await runExplorerFlow(session, {
			showExplorer: async (_s, relativePath): Promise<ExplorerResult> => {
				explorerCalls.push(relativePath);
				call++;
				if (call === 1) return { kind: "open-file", absolutePath: join(repoRoot as string, "src", "index.ts") };
				return { kind: "quit" };
			},
			showEditor: async (absolutePath) => {
				const editSession = await openEditorFile(absolutePath);
				openedFiles.push({ path: absolutePath, content: editSession.content });
			},
		});

		expect(explorerCalls).toEqual(["", "src"]);
		expect(openedFiles).toEqual([{ path: join(repoRoot, "src", "index.ts"), content: "export {};\n" }]);
	});

	it("creates a real file on disk through the explorer's mutation primitives", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		repoRoot = fakeRepo();

		const session = await openDirectoryExplorer(repoRoot);
		await session.createFile("new-file.txt");

		const listing = await session.listDirectory("");
		expect(listing.entries.map((e) => e.name).sort()).toEqual(["new-file.txt", "readme.md", "src"]);
	});
});
