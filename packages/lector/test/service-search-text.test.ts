/**
 * Service-level wiring for workspace.searchText: a real RipgrepTextSearch scoped to a registered
 * workspace's root, plus the default in-memory cache actually intercepting a repeat query. Real
 * ripgrep/cache correctness is already covered directly in their own adapter test files.
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

describe("createLectorService's workspace.searchText", () => {
	it("rejects an unknown workspaceId before ever touching ripgrep", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(
			service.dispatch("workspace.searchText", { workspaceId: "never-registered", query: "hello", maxMatches: 10, maxBytes: 1000 }),
		).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("rejects a workspace with no known root path (e.g. an in-memory-only registration)", async () => {
		const { InMemoryWorkspace } = await import("../src/workspace/in-memory-workspace.ts");
		service = createLectorService(new Map([["mem-1", new InMemoryWorkspace()]]));
		await expect(service.dispatch("workspace.searchText", { workspaceId: "mem-1", query: "hello", maxMatches: 10, maxBytes: 1000 })).rejects.toBeInstanceOf(
			SymbolQueryUnavailable,
		);
	});

	it("routes a real query through the default RipgrepTextSearch backend end to end", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-search-text-service-"));
		writeFileSync(join(root, "a.txt"), "hello world\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.searchText", { workspaceId, query: "hello", maxMatches: 100, maxBytes: 10_000 });

		expect(result.matches).toContainEqual({ path: "a.txt", lineNumber: 1, line: "hello world\n", matchStart: 0, matchEnd: 5 });
	});

	it("the default cache intercepts a repeat query for the same workspace", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-search-text-service-"));
		writeFileSync(join(root, "a.txt"), "hello world\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const first = await service.dispatch("workspace.searchText", { workspaceId, query: "hello", maxMatches: 100, maxBytes: 10_000 });
		// Prove caching by making the underlying file unreadable to a fresh search and confirming
		// the cached result still comes back unchanged, rather than reflecting the new state.
		writeFileSync(join(root, "a.txt"), "totally different content\n");
		const second = await service.dispatch("workspace.searchText", { workspaceId, query: "hello", maxMatches: 100, maxBytes: 10_000 });

		expect(second).toEqual(first);
	});
});
