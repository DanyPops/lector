/**
 * One shared conformance suite, run unmodified against every
 * WorkspacePort implementation -- proves LocalFilesystemWorkspace behaves
 * identically to InMemoryWorkspace for every operation both must support.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { LocalFilesystemWorkspace } from "../src/adapters/local-filesystem-workspace.ts";
import { runWorkspacePortConformanceSuite } from "./support/workspace-port-conformance.ts";

runWorkspacePortConformanceSuite("InMemoryWorkspace", {
	createWorkspace: () => new InMemoryWorkspace(),
});

function localFilesystemHarness() {
	let currentRoot: string | undefined;
	return {
		createWorkspace: async () => {
			currentRoot = await mkdtemp(join(tmpdir(), "lector-conformance-"));
			return new LocalFilesystemWorkspace(currentRoot);
		},
		cleanup: async () => {
			if (currentRoot) await rm(currentRoot, { recursive: true, force: true });
			currentRoot = undefined;
		},
	};
}

runWorkspacePortConformanceSuite("LocalFilesystemWorkspace", localFilesystemHarness());
