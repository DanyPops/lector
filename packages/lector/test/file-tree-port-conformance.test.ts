/**
 * One shared conformance suite, run unmodified against every FileTreePort implementation --
 * proves LocalFilesystemWorkspace behaves identically to InMemoryWorkspace for every directory
 * operation both must support.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { LocalFilesystemWorkspace } from "../src/adapters/local-filesystem-workspace.ts";
import { runFileTreePortConformanceSuite } from "./support/file-tree-port-conformance.ts";

runFileTreePortConformanceSuite("InMemoryWorkspace", {
	create: async () => {
		const workspace = new InMemoryWorkspace();
		return { fileTree: workspace, writeFile: (path, content) => workspace.writeEntry(path, null, content).then(() => undefined) };
	},
});

function localFilesystemHarness() {
	let currentRoot: string | undefined;
	return {
		create: async () => {
			currentRoot = await mkdtemp(join(tmpdir(), "lector-file-tree-conformance-"));
			const workspace = new LocalFilesystemWorkspace(currentRoot);
			return { fileTree: workspace, writeFile: (path: string, content: string) => workspace.writeEntry(path, null, content).then(() => undefined) };
		},
		cleanup: async () => {
			if (currentRoot) await rm(currentRoot, { recursive: true, force: true });
			currentRoot = undefined;
		},
	};
}

runFileTreePortConformanceSuite("LocalFilesystemWorkspace", localFilesystemHarness());
