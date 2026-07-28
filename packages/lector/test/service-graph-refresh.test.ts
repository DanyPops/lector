/**
 * Service-level wiring: once a workspace's symbol graph has been populated at least once,
 * a real file change under its root should trigger a debounced, deduplicated re-population
 * automatically -- without any caller re-invoking workspace.populateSymbolGraph -- and should
 * also forward the change to the workspace's warm code-intelligence index via
 * notifyFileChanged. Uses an injected fake CodeIntelligencePort (not a real LSP subprocess:
 * that plumbing is already proven end to end in test/adapters/lsp/notify-file-changed.test.ts
 * and test/adapters/lsp/lsp-symbol-index.test.ts) so runs are fast and deterministic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentSymbolEntry } from "../src/domain/document-symbol.ts";
import type { FileChangeEvent } from "../src/domain/file-change-event.ts";
import type { IntelligenceProvenance } from "../src/domain/intelligence-provenance.ts";
import type { CodeIntelligencePort } from "../src/ports/code-intelligence-port.ts";
import type { ClosableSymbolIndex, LectorService } from "../src/service.ts";
import { createLectorService } from "../src/service.ts";

const PROVENANCE: IntelligenceProvenance = {
	fidelity: "semantic",
	backend: "stub-server",
	languageId: "typescript",
	authority: "language-server",
	freshness: "live-process",
	limitations: [],
};

interface StubIndex {
	readonly index: ClosableSymbolIndex & CodeIntelligencePort;
	readonly notifiedEvents: FileChangeEvent[];
	documentSymbolsCalls: number;
}

function stubIndex(options: { documentSymbolsDelayMs?: number } = {}): StubIndex {
	const notifiedEvents: FileChangeEvent[] = [];
	const state: StubIndex = {
		notifiedEvents,
		documentSymbolsCalls: 0,
		index: {
			provenance: PROVENANCE,
			findSymbols: async () => ({ symbols: [], truncated: false, provenance: PROVENANCE }),
			goToDefinition: async () => [],
			goToImplementation: async () => [],
			findReferences: async () => [],
			hover: async () => undefined,
			documentSymbols: async (): Promise<DocumentSymbolEntry[]> => {
				state.documentSymbolsCalls++;
				if (options.documentSymbolsDelayMs) await new Promise((resolve) => setTimeout(resolve, options.documentSymbolsDelayMs));
				return [];
			},
			diagnostics: async () => [],
			prepareCallHierarchy: async () => [],
			incomingCalls: async () => [],
			outgoingCalls: async () => [],
			releaseFile: async () => {},
			notifyFileChanged: (event: FileChangeEvent) => notifiedEvents.push(event),
			close: async () => {},
		},
	};
	return state;
}

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function buildFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "lector-graph-refresh-"));
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["."] }));
	return dir;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for the expected condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("createLectorService's automatic graph-freshness watching", () => {
	it("re-populates the symbol graph automatically after a real file change, once the workspace has been populated at least once", async () => {
		root = buildFixture();
		const stub = stubIndex();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => stub.index, graphRefreshDebounceMs: 30 });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		const callsAfterFirstPopulation = stub.documentSymbolsCalls;
		expect(callsAfterFirstPopulation).toBeGreaterThan(0);

		writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
		await waitFor(() => stub.documentSymbolsCalls > callsAfterFirstPopulation);
	});

	it("coalesces a rapid burst of file changes into exactly one automatic re-population", async () => {
		root = buildFixture();
		const stub = stubIndex();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => stub.index, graphRefreshDebounceMs: 80 });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		const before = stub.documentSymbolsCalls;

		for (let i = 0; i < 5; i++) {
			writeFileSync(join(root, `burst-${i}.ts`), `export const v${i} = ${i};\n`);
			await new Promise((resolve) => setTimeout(resolve, 10)); // well inside the 80ms debounce window
		}

		// Give the debounce window plus a real re-population run time to complete, then confirm
		// it ran exactly once more, not once per burst write.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(stub.documentSymbolsCalls).toBeGreaterThan(before);
		const runsTriggered = stub.documentSymbolsCalls - before;
		// Each run calls documentSymbols once per discovered file; a second run would at least
		// double the per-run file count, which is what this bounds against without hardcoding
		// the exact file count.
		expect(runsTriggered).toBeLessThanOrEqual(6); // one run over up to 6 files (a.ts + 5 burst files)
	});

	it("never auto-populates a workspace that has only been watched, never populated", async () => {
		root = buildFixture();
		const stub = stubIndex();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => stub.index, graphRefreshDebounceMs: 30 });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.watch", { workspaceId, pattern: "*.ts" });

		writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(stub.documentSymbolsCalls).toBe(0);
	});

	it("keeps the OS watcher alive for graph freshness even after every agent-registered workspace.watch is removed", async () => {
		root = buildFixture();
		const stub = stubIndex();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => stub.index, graphRefreshDebounceMs: 30 });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		const callsAfterFirstPopulation = stub.documentSymbolsCalls;

		const { watchId } = await service.dispatch("workspace.watch", { workspaceId, pattern: "*.ts" });
		expect(await service.dispatch("workspace.unwatch", { watchId })).toEqual({ unwatched: true });

		writeFileSync(join(root, "c.ts"), "export const c = 3;\n");
		await waitFor(() => stub.documentSymbolsCalls > callsAfterFirstPopulation);
	});

	it("forwards a real file change to the workspace's warm code-intelligence index via notifyFileChanged", async () => {
		root = buildFixture();
		const stub = stubIndex();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => stub.index, graphRefreshDebounceMs: 30 });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		writeFileSync(join(root, "d.ts"), "export const d = 4;\n");
		await waitFor(() => stub.notifiedEvents.some((event) => event.path === "d.ts"));

		expect(stub.notifiedEvents.find((event) => event.path === "d.ts")).toMatchObject({ path: "d.ts", kind: "created" });
	});

	it("re-arms a refresh for a change that arrives while a refresh is already running, instead of silently dropping it", async () => {
		root = buildFixture();
		const stub = stubIndex({ documentSymbolsDelayMs: 150 });
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => stub.index, graphRefreshDebounceMs: 20 });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		const before = stub.documentSymbolsCalls;
		const initialStatus = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		const initialCompletedAt = initialStatus.status === "cached" || initialStatus.status === "partial" ? initialStatus.generation.completedAt : 0;

		writeFileSync(join(root, "e.ts"), "export const e = 5;\n");
		await waitFor(() => stub.documentSymbolsCalls > before); // first auto-refresh has started (slow, still running)

		// Arrives while the first auto-refresh is still in flight -- the running refresh's own
		// before/after fingerprint check will detect this and fail that specific run
		// (WorkspaceChangedDuringPopulation, existing protective behavior, not new). The real thing
		// under test is that this change is not silently lost forever: a fresh run must eventually
		// succeed and produce a generation newer than the very first one.
		writeFileSync(join(root, "f.ts"), "export const f = 6;\n");

		await waitFor(async () => {
			const status = await service?.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
			return (status?.status === "cached" || status?.status === "partial") && status.generation.completedAt > initialCompletedAt;
		}, 5000);
	});
});
