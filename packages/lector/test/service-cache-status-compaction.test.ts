/**
 * workspace.cacheStatus's default response must stay compact regardless of how many files a
 * generation walked or how many failures it recorded -- see the pagination/detail operations
 * (workspace.cacheWalkedFiles, workspace.cacheFailures) for the full raw picture on request.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoCompletedGeneration, UnknownWorkspace } from "../src/service/errors.ts";
import { createLectorService, type LectorService } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

/** One real file that fails population (a Go test file with no package metadata), so the resulting generation carries a genuine walkedFiles list and a genuine failure to compact. */
function buildFixtureWithOneFailure(): { root: string; orphanGoTest: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-cache-status-compaction-"));
	mkdirSync(join(root, "worker"));
	writeFileSync(join(root, "worker", "go.mod"), "module fixture/worker\n\ngo 1.22\n");
	writeFileSync(
		join(root, "worker", "main.go"),
		"package worker\n\nfunc leaf(value int) int { return value }\n\nfunc only(a int, b int) int { return leaf(a + b) }\n",
	);
	const orphanGoTest = join(root, "e2e_test.go");
	writeFileSync(orphanGoTest, "//go:build e2e\n\npackage fixture_test\n\nfunc TestOrphan() {}\n");
	return { root, orphanGoTest };
}

describe("workspace.cacheStatus response compaction", () => {
	it("never inlines walkedFiles or fileContentHashes -- reports only a count", async () => {
		const { root } = buildFixtureWithOneFailure();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });

		const status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });
		expect(status.status).toBe("partial");
		if (status.status !== "partial") throw new Error("expected partial status");
		expect(status.generation).not.toHaveProperty("walkedFiles");
		expect(status.generation).not.toHaveProperty("fileContentHashes");
		expect(status.generation.walkedFileCount).toBe(2);
	}, 30_000);

	it("replaces the raw failures array with a bounded, deduplicated failureSummary", async () => {
		const { root, orphanGoTest } = buildFixtureWithOneFailure();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });

		const status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });
		expect(status.status).toBe("partial");
		if (status.status !== "partial") throw new Error("expected partial status");
		expect(status.generation.result).not.toHaveProperty("failures");
		expect(status.generation.result.failureCount).toBe(1);
		expect(status.generation.result.failureSummary).toHaveLength(1);
		expect(status.generation.result.failureSummary[0]).toMatchObject({ path: orphanGoTest, operation: "outgoing-calls", count: 1 });
		expect(status.generation.result.failureSummaryTruncated).toBe(false);
	}, 30_000);
});

describe("workspace.cacheWalkedFiles", () => {
	it("returns the full raw walked-file list behind the compact summary, paginated", async () => {
		const { root } = buildFixtureWithOneFailure();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });

		const page = await service.dispatch("workspace.cacheWalkedFiles", { workspaceId, offset: 0, maxResults: 1, maxBytes: 1_000_000 });
		expect(page.totalCount).toBe(2);
		expect(page.files).toHaveLength(1);
		expect(page.nextOffset).toBe(1);
		expect(page.truncated).toBe(true);

		const rest = await service.dispatch("workspace.cacheWalkedFiles", { workspaceId, offset: page.nextOffset, maxResults: 10, maxBytes: 1_000_000 });
		expect(rest.files).toHaveLength(1);
		expect(rest.nextOffset).toBe(2);
		expect(rest.truncated).toBe(false);
	}, 30_000);

	it("throws NoCompletedGeneration for a registered workspace that was never populated", async () => {
		const { root } = buildFixtureWithOneFailure();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await expect(service.dispatch("workspace.cacheWalkedFiles", { workspaceId, offset: 0, maxResults: 10, maxBytes: 1_000 })).rejects.toThrow(
			NoCompletedGeneration,
		);
	});

	it("throws UnknownWorkspace for an id nothing ever registered", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("workspace.cacheWalkedFiles", { workspaceId: "does-not-exist", offset: 0, maxResults: 10, maxBytes: 1_000 })).rejects.toThrow(
			UnknownWorkspace,
		);
	});
});

describe("workspace.cacheFailures", () => {
	it("returns the full raw failure records behind the compact summary, paginated", async () => {
		const { root, orphanGoTest } = buildFixtureWithOneFailure();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });

		const page = await service.dispatch("workspace.cacheFailures", { workspaceId, offset: 0, maxResults: 10, maxBytes: 1_000_000 });
		expect(page.totalCount).toBe(1);
		expect(page.nextOffset).toBe(1);
		expect(page.truncated).toBe(false);
		expect(page.failures[0]).toMatchObject({ path: orphanGoTest, operation: "outgoing-calls" });
		expect(page.failures[0]?.message).toContain("no package metadata");
	}, 30_000);

	it("throws NoCompletedGeneration for a registered workspace that was never populated", async () => {
		const { root } = buildFixtureWithOneFailure();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await expect(service.dispatch("workspace.cacheFailures", { workspaceId, offset: 0, maxResults: 10, maxBytes: 1_000 })).rejects.toThrow(
			NoCompletedGeneration,
		);
	});
});
