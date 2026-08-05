/**
 * search.symbols / search.text fan out across every registered workspace with a known root.
 * Uses a real RipgrepTextSearch (search.text needs no fake -- ripgrep has no warm/cold state to
 * simulate) and a deliberately slow fake SymbolIndexPort for the one test that needs to prove
 * "loading" is reported rather than blocking the whole call or silently omitting a workspace.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClosableSymbolIndex, LectorService } from "../src/service.ts";
import { createLectorService } from "../src/service.ts";
import type { WorkspaceQueryOutcome } from "../src/workspace/workspace-query-outcome.ts";
import type { WorkspaceSymbol } from "../src/workspace/workspace-symbol.ts";
import { symbolSearchResult, TEST_SEMANTIC_PROVENANCE } from "./support/intelligence-provenance.ts";

function expectReady<T>(outcome: WorkspaceQueryOutcome<T> | undefined, workspaceId: string): T {
	if (!outcome) throw new Error(`no outcome for workspace ${workspaceId}`);
	if (outcome.status !== "ready") throw new Error(`expected ${workspaceId} to be ready, got ${outcome.status}: ${outcome.message}`);
	return outcome.result;
}

let dirs: string[] = [];
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function buildDir(fileName: string, content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "lector-cross-search-"));
	writeFileSync(join(dir, fileName), content);
	dirs.push(dir);
	return dir;
}

class InstantSymbolIndex implements ClosableSymbolIndex {
	readonly provenance = TEST_SEMANTIC_PROVENANCE;
	constructor(private readonly symbol: WorkspaceSymbol) {}
	async findSymbols() {
		return symbolSearchResult([this.symbol]);
	}
	async close(): Promise<void> {}
}

class NeverSettlesSymbolIndex implements ClosableSymbolIndex {
	readonly provenance = TEST_SEMANTIC_PROVENANCE;
	async findSymbols() {
		return new Promise<never>(() => {}); // deliberately never resolves within any test's own budget
	}
	async close(): Promise<void> {}
}

describe("createLectorService's search.symbols (cross-workspace fan-out)", () => {
	it("returns a ready outcome with real results for every fast workspace", async () => {
		const dirA = buildDir("a.ts", "export function found() {}");
		const dirB = buildDir("b.ts", "export function found() {}");
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: () => new InstantSymbolIndex({ name: "found", kind: "function", location: { path: "x", line: 1, character: 1 } }),
		});
		const { workspaceId: idA } = await service.dispatch("workspace.registerPath", { path: dirA });
		const { workspaceId: idB } = await service.dispatch("workspace.registerPath", { path: dirB });

		const { results } = await service.dispatch("search.symbols", { query: "found" });

		expect(results.length).toBe(2);
		const byId = new Map(results.map((r) => [r.workspaceId, r]));
		expect(expectReady(byId.get(idA), idA).symbols[0]?.name).toBe("found");
		expect(byId.get(idB)?.status).toBe("ready");
	});

	it("reports a slow workspace as loading rather than blocking the whole call or silently omitting it", async () => {
		const dirFast = buildDir("a.ts", "export function found() {}");
		const dirSlow = buildDir("b.ts", "export function found() {}");
		let calls = 0;
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: () => {
				calls++;
				// The first workspace registered/queried is fast; the second is deliberately hung --
				// the test never depends on which is which by directory, only on call order, since
				// createSymbolIndex is invoked lazily in registration order below.
				return calls === 1
					? new InstantSymbolIndex({ name: "found", kind: "function", location: { path: "x", line: 1, character: 1 } })
					: new NeverSettlesSymbolIndex();
			},
		});
		const { workspaceId: fastId } = await service.dispatch("workspace.registerPath", { path: dirFast });
		const { workspaceId: slowId } = await service.dispatch("workspace.registerPath", { path: dirSlow });

		const start = Date.now();
		const { results } = await service.dispatch("search.symbols", { query: "found", timeoutMs: 50 });
		const elapsedMs = Date.now() - start;

		expect(elapsedMs).toBeLessThan(2000); // did not block on the hung workspace
		const byId = new Map(results.map((r) => [r.workspaceId, r]));
		expectReady(byId.get(fastId), fastId);
		const slowOutcome = byId.get(slowId);
		expect(slowOutcome?.status).toBe("loading");
		if (slowOutcome?.status === "loading") expect(slowOutcome.message).toBeTruthy();
	});

	it("excludes a workspace with no known root path from the fan-out, rather than erroring on it", async () => {
		const { InMemoryWorkspace } = await import("../src/workspace/in-memory-workspace.ts");
		service = createLectorService(new Map([["mem-1", new InMemoryWorkspace()]]));

		const { results } = await service.dispatch("search.symbols", { query: "anything" });

		expect(results).toEqual([]);
	});

	it("returns an empty results array, not an error, when no workspace has a known root", async () => {
		const { InMemoryWorkspace } = await import("../src/workspace/in-memory-workspace.ts");
		service = createLectorService(new Map([["mem-1", new InMemoryWorkspace()]]));
		const { results } = await service.dispatch("search.text", { query: "anything", maxMatches: 10, maxBytes: 1000 });
		expect(results).toEqual([]);
	});

	it("an explicit workspaceIds list restricts the fan-out to exactly those, excluding every other registered workspace -- the fix for a real live finding: this daemon is shared, and 'every registered workspace' can include a completely unrelated project another concurrent session registered", async () => {
		const dirA = buildDir("a.ts", "export function found() {}");
		const dirB = buildDir("b.ts", "export function found() {}");
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: () => new InstantSymbolIndex({ name: "found", kind: "function", location: { path: "x", line: 1, character: 1 } }),
		});
		const { workspaceId: idA } = await service.dispatch("workspace.registerPath", { path: dirA });
		await service.dispatch("workspace.registerPath", { path: dirB }); // registered, but deliberately not passed below

		const { results } = await service.dispatch("search.symbols", { query: "found", workspaceIds: [idA] });

		expect(results.length).toBe(1);
		expect(results[0]?.workspaceId).toBe(idA);
	});

	it("an explicit workspaceIds entry that isn't registered is reported as a per-entry error, not silently dropped or thrown", async () => {
		const dirA = buildDir("a.ts", "export function found() {}");
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: () => new InstantSymbolIndex({ name: "found", kind: "function", location: { path: "x", line: 1, character: 1 } }),
		});
		const { workspaceId: idA } = await service.dispatch("workspace.registerPath", { path: dirA });

		const { results } = await service.dispatch("search.symbols", { query: "found", workspaceIds: [idA, "never-registered"] });

		expect(results.length).toBe(2);
		const byId = new Map(results.map((r) => [r.workspaceId, r]));
		expectReady(byId.get(idA), idA);
		const unknownOutcome = byId.get("never-registered");
		expect(unknownOutcome?.status).toBe("error");
		if (unknownOutcome?.status === "error") expect(unknownOutcome.message).toContain("never-registered");
	});
});

describe("createLectorService's search.text (cross-workspace fan-out)", () => {
	it("finds real matches independently across two registered workspaces", async () => {
		const dirA = buildDir("a.txt", "hello world\n");
		const dirB = buildDir("b.txt", "hello again\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId: idA } = await service.dispatch("workspace.registerPath", { path: dirA });
		const { workspaceId: idB } = await service.dispatch("workspace.registerPath", { path: dirB });

		const { results } = await service.dispatch("search.text", { query: "hello", maxMatches: 100, maxBytes: 10_000 });

		const byId = new Map(results.map((r) => [r.workspaceId, r]));
		expect(expectReady(byId.get(idA), idA).matches[0]?.path).toBe("a.txt");
		expect(expectReady(byId.get(idB), idB).matches[0]?.path).toBe("b.txt");
	});
});
