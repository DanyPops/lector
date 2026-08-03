/**
 * Service-level wiring for the FileTreePort operations: workspace resolution and
 * WorkspaceDoesNotSupportFileTree routing. Full LocalFilesystemWorkspace/InMemoryWorkspace
 * correctness is already covered directly in test/file-tree-port-conformance.test.ts; this file
 * only proves dispatch is wired end to end through the real RPC operation names.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { ReadOnlyWorkspace } from "../src/adapters/read-only-workspace.ts";
import { createLectorService, type LectorService, UnknownWorkspace, WorkspaceDoesNotSupportFileTree } from "../src/service.ts";

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("createLectorService's file-tree operations", () => {
	it("listDirectory/createDirectory/renamePath/deleteDirectory route through a real registered local workspace", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-file-tree-service-"));
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "readme.md"), "hello");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const initial = await service.dispatch("workspace.listDirectory", { workspaceId, path: "" });
		expect(initial.entries.map((entry) => entry.name)).toEqual(["src", "readme.md"]);

		await service.dispatch("workspace.createDirectory", { workspaceId, path: "docs" });
		await service.dispatch("workspace.renamePath", { workspaceId, oldPath: "readme.md", newPath: "README.md" });
		await service.dispatch("workspace.deleteDirectory", { workspaceId, path: "src" });

		const after = await service.dispatch("workspace.listDirectory", { workspaceId, path: "" });
		expect(after.entries.map((entry) => entry.name)).toEqual(["docs", "README.md"]);
	});

	it("rejects an unknown workspaceId before ever touching the filesystem", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("workspace.listDirectory", { workspaceId: "never-registered", path: "" })).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("rejects a read-only workspace with WorkspaceDoesNotSupportFileTree, not a confusing low-level error", async () => {
		const workspaces = new Map([["readonly", new ReadOnlyWorkspace(new InMemoryWorkspace())]]);
		service = createLectorService(workspaces);
		await expect(service.dispatch("workspace.listDirectory", { workspaceId: "readonly", path: "" })).rejects.toBeInstanceOf(WorkspaceDoesNotSupportFileTree);
	});
});
