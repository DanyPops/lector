/**
 * Service-level wiring for workspace.searchText and indexed-search lifecycle seams, plus the
 * default in-memory cache. Adapter correctness has focused suites.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChangeEvent } from "../src/file-watcher/file-change-event.ts";
import type { FileWatcherPort } from "../src/file-watcher/port.ts";
import { createLectorService, type LectorService, SymbolQueryUnavailable, UnknownWorkspace } from "../src/service.ts";
import type { FindFilesOptions, TextSearchOptions, TextSearchPort, TextSearchWorkspaceOrigin } from "../src/text-search/port.ts";
import { RipgrepTextSearch } from "../src/text-search/ripgrep-text-search.ts";

let root: string | undefined;
let cacheRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	if (cacheRoot) rmSync(cacheRoot, { recursive: true, force: true });
	cacheRoot = undefined;
});

class LifecycleTextSearch implements TextSearchPort {
	searches = 0;
	readonly registrations: Array<{ rootPath: string; origin: TextSearchWorkspaceOrigin }> = [];
	readonly invalidations: string[] = [];
	readonly releases: string[] = [];
	async search(_rootPath: string, query: string, _options: TextSearchOptions) {
		this.searches += 1;
		return { matches: [{ path: "a.txt", lineNumber: 1, line: query, matchStart: 0, matchEnd: query.length }], truncated: false };
	}
	async findFiles(_rootPath: string, _patterns: readonly string[], _options: FindFilesOptions) {
		return { paths: [], truncated: false };
	}
	registerWorkspace(rootPath: string, origin: TextSearchWorkspaceOrigin): void {
		this.registrations.push({ rootPath, origin });
	}
	invalidate(rootPath: string): void {
		this.invalidations.push(rootPath);
	}
	releaseWorkspace(rootPath: string): void {
		this.releases.push(rootPath);
	}
}

class FixtureWatcher implements FileWatcherPort {
	onEvent?: (event: FileChangeEvent) => void;
	watch(_rootPath: string, onEvent: (event: FileChangeEvent) => void) {
		this.onEvent = onEvent;
		return { close() {} };
	}
}

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

	it("switches from fresh fallback to the default resident index", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-search-text-service-"));
		cacheRoot = mkdtempSync(join(tmpdir(), "lector-search-text-cache-"));
		writeFileSync(join(root, "a.txt"), "hello world\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true, textIndexCacheRoot: cacheRoot });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const fallback = await service.dispatch("workspace.searchText", { workspaceId, query: "hello", maxMatches: 100, maxBytes: 10_000 });
		expect(fallback.provenance).toMatchObject({ backend: "ripgrep", indexState: "loading" });
		let indexed = fallback;
		for (let attempt = 0; attempt < 100 && indexed.provenance?.backend !== "fff"; attempt += 1) {
			await Bun.sleep(10);
			indexed = await service.dispatch("workspace.searchText", { workspaceId, query: "hello", maxMatches: 101 + attempt, maxBytes: 10_000 });
		}
		expect(indexed.provenance).toMatchObject({ backend: "fff", indexState: "ready", indexedFiles: 1 });
		expect(indexed.matches[0]).toMatchObject({ path: "a.txt", lineNumber: 1, matchStart: 0, matchEnd: 5 });
	}, 30_000);

	it("registers index lifecycle and invalidates the workspace cache from watcher events", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-search-text-service-"));
		writeFileSync(join(root, "a.txt"), "hello world\n");
		const textSearch = new LifecycleTextSearch();
		const watcher = new FixtureWatcher();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createTextSearch: () => textSearch,
			createFileWatcher: () => watcher,
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const input = { workspaceId, query: "hello", maxMatches: 100, maxBytes: 10_000 };
		await service.dispatch("workspace.searchText", input);
		await service.dispatch("workspace.searchText", input);
		expect(textSearch.searches).toBe(1);
		expect(textSearch.registrations).toEqual([
			{ rootPath: root, origin: "local" },
			{ rootPath: root, origin: "local" },
		]);
		watcher.onEvent?.({ path: "a.txt", kind: "modified" });
		for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
		await service.dispatch("workspace.searchText", input);
		expect(textSearch.invalidations).toEqual([root]);
		expect(textSearch.searches).toBe(2);
		await service.dispatch("workspace.release", { workspaceId });
		expect(textSearch.releases).toEqual([root]);
	});

	it("the default cache intercepts a repeat query for the same workspace", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-search-text-service-"));
		writeFileSync(join(root, "a.txt"), "hello world\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true, createTextSearch: () => new RipgrepTextSearch() });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const first = await service.dispatch("workspace.searchText", { workspaceId, query: "hello", maxMatches: 100, maxBytes: 10_000 });
		// Prove caching by making the underlying file unreadable to a fresh search and confirming
		// the cached result still comes back unchanged, rather than reflecting the new state.
		writeFileSync(join(root, "a.txt"), "totally different content\n");
		const second = await service.dispatch("workspace.searchText", { workspaceId, query: "hello", maxMatches: 100, maxBytes: 10_000 });

		expect(second).toEqual(first);
	});
});
