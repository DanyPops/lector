/**
 * Service-level wiring for workspace.findFiles: a real RipgrepTextSearch scoped to a registered
 * workspace's root. Real ripgrep correctness is already covered directly in
 * test/adapters/ripgrep-text-search.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorService, type LectorService, SymbolQueryUnavailable, UnknownWorkspace } from "../src/service.ts";

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("createLectorService's workspace.findFiles", () => {
	it("rejects an unknown workspaceId before ever touching ripgrep", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(
			service.dispatch("workspace.findFiles", { workspaceId: "never-registered", patterns: ["*.ts"], maxResults: 10, maxBytes: 1000 }),
		).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("rejects a workspace with no known root path (e.g. an in-memory-only registration)", async () => {
		const { InMemoryWorkspace } = await import("../src/adapters/in-memory-workspace.ts");
		service = createLectorService(new Map([["mem-1", new InMemoryWorkspace()]]));
		await expect(service.dispatch("workspace.findFiles", { workspaceId: "mem-1", patterns: ["*.ts"], maxResults: 10, maxBytes: 1000 })).rejects.toBeInstanceOf(
			SymbolQueryUnavailable,
		);
	});

	it("routes a real glob pattern through the default RipgrepTextSearch backend end to end", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-find-files-service-"));
		writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(root, "b.md"), "# doc\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.findFiles", { workspaceId, patterns: ["*.ts"], maxResults: 100, maxBytes: 10_000 });

		expect(result).toEqual({ paths: ["a.ts"], truncated: false });
	});
});
