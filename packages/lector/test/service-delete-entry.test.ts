/**
 * Service-level wiring for workspace.deleteEntry -- a real file delete, hash-guarded the same
 * way exactEdit's own write guard works. Previously the only way to delete a file's WorkspacePort
 * entry was internal to workspace.revertMutation; this is the first public RPC surface for it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHashOf } from "../src/content-identity/content-hash.ts";
import { createLectorService, type LectorService } from "../src/service.ts";
import { StaleExpectedHash } from "../src/workspace/exact-edit.ts";

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("createLectorService's workspace.deleteEntry", () => {
	it("deletes a file guarded by its current hash", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-delete-entry-service-"));
		writeFileSync(join(root, "doomed.txt"), "hello");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.deleteEntry", { workspaceId, path: "doomed.txt", expectedHash: contentHashOf("hello") });
		expect(result.previousHash).toBe(contentHashOf("hello"));

		await expect(service.dispatch("workspace.rawRead", { workspaceId, path: "doomed.txt" })).rejects.toThrow();
	});

	it("rejects a stale expectedHash rather than silently deleting", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-delete-entry-stale-"));
		writeFileSync(join(root, "doomed.txt"), "hello");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await expect(
			service.dispatch("workspace.deleteEntry", { workspaceId, path: "doomed.txt", expectedHash: contentHashOf("wrong content") }),
		).rejects.toBeInstanceOf(StaleExpectedHash);
	});
});
