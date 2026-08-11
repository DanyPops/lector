/**
 * Service-level wiring for workspace.narrowedType -- a real TypeScript-compiler-API operation
 * (a fresh single-file ts.Program per call, not the shared warm LSP index code-intelligence-
 * handlers.ts leases). Real flow-narrowing correctness is already covered directly in
 * test/code-intelligence/typescript-narrowed-type.test.ts; this file only covers the service's
 * own wiring (workspace resolution, path resolution, bounds).
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

describe("createLectorService's workspace.narrowedType", () => {
	it("rejects an unknown workspaceId before ever touching the filesystem", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("workspace.narrowedType", { workspaceId: "never-registered", path: "a.ts", line: 1, character: 1 })).rejects.toBeInstanceOf(
			UnknownWorkspace,
		);
	});

	it("routes a real file through the real TypeScript checker end to end, resolving a workspace-relative path", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-narrowed-type-service-"));
		const source = [
			"export function describe(input: string | number): string {",
			'\tif (typeof input === "string") {',
			"\t\treturn input.toUpperCase();",
			"\t}",
			"\treturn input.toFixed(2);",
			"}",
			"",
		].join("\n");
		writeFileSync(join(root, "guard.ts"), source);
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.narrowedType", { workspaceId, path: "guard.ts", line: 3, character: 10 });

		expect(result).toEqual({ type: { declaredType: "string | number", narrowedType: "string", narrowed: true }, truncated: false });
	});

	it("returns an undefined type for a position with no identifier, not an error", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-narrowed-type-service-empty-"));
		writeFileSync(join(root, "plain.ts"), "export const x = 1;\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.narrowedType", { workspaceId, path: "plain.ts", line: 1, character: 1 });

		expect(result).toEqual({ type: undefined, truncated: false });
	});
});
