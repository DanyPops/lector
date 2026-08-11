/**
 * Service-level wiring for workspace.dataFlowHints -- a pure tree-sitter/syntactic operation
 * (no warm LSP index, no IntelligenceProvenance), reading the file via the same WorkspacePort
 * every other file operation uses. Real tree-sitter node-shape correctness is already covered
 * directly in test/code-intelligence/tree-sitter/data-flow-hints.test.ts; this file only covers
 * the service's own wiring (workspace resolution, bounds, missing-file/registration behavior).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorService, type LectorService, UnknownWorkspace } from "../src/service.ts";

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("createLectorService's workspace.dataFlowHints", () => {
	it("rejects an unknown workspaceId before ever touching the filesystem", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("workspace.dataFlowHints", { workspaceId: "never-registered", path: "a.ts" })).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("routes a real file through the tree-sitter heuristic end to end", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-data-flow-hints-service-"));
		writeFileSync(join(root, "a.ts"), "const x = y;\nz = w.field;\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.dataFlowHints", { workspaceId, path: "a.ts" });

		expect(result.truncated).toBe(false);
		expect(result.hints.map((hint) => [hint.toVariable, hint.fromVariable, hint.kind])).toEqual([
			["x", "y", "comesFrom"],
			["z", "w", "computedFrom"],
		]);
	});

	it("returns an empty result for a file with no assignment-shaped statements, not an error", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-data-flow-hints-empty-"));
		writeFileSync(join(root, "a.ts"), "export function f() {}\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.dataFlowHints", { workspaceId, path: "a.ts" });

		expect(result).toEqual({ hints: [], truncated: false });
	});

	it("returns an empty result for a path that does not exist, not an error", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-data-flow-hints-missing-"));
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.dataFlowHints", { workspaceId, path: "missing.ts" });

		expect(result).toEqual({ hints: [], truncated: false });
	});
});
