/**
 * The real live regression this fixes: a populateSymbolGraph background job holds an ACTIVE
 * (not idle) warm-index lease for its whole run, so nothing can evict it to admit a different
 * workspace's foreground query -- with shared, unreserved capacity, foreground starves until the
 * job finishes. reservedForegroundSlots gives foreground its own headroom background can never
 * grow into, so a concurrent foreground query for a different workspace is admitted promptly
 * instead of throwing WarmIndexCapacityExceeded.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentSymbolEntry } from "../src/code-intelligence/document-symbol.ts";
import type { LanguageServerDescriptor } from "../src/code-intelligence/language-server-descriptor.ts";
import { WarmIndexCapacityExceeded } from "../src/service/warm-index-registry.ts";
import type { ClosableSymbolIndex, LectorService } from "../src/service.ts";
import { createLectorService } from "../src/service.ts";
import type { WorkspaceLocation } from "../src/workspace/workspace-symbol.ts";
import { symbolSearchResult, TEST_SEMANTIC_PROVENANCE } from "./support/intelligence-provenance.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

/**
 * Blocks on documentSymbols until released -- simulates populateSymbolGraph mid-flight, holding
 * its lease ACTIVE (never idle, so it can never simply be evicted). `entered` resolves the
 * instant documentSymbols() is actually called -- by then the lease is provably held (leasing
 * happens before populateSymbolGraphQuery ever calls documentSymbols), the only fully
 * deterministic point to synchronize a test on, as opposed to inferring lease state from
 * job.status ("running" reflects executor scheduling, not lease acquisition specifically, and
 * the population handler's own real work before leasing -- including the broad-non-project-root
 * classification's own directory read -- is not a fixed number of ticks).
 */
class BlockedOnDocumentSymbolsIndex implements ClosableSymbolIndex {
	readonly provenance = TEST_SEMANTIC_PROVENANCE;
	private readonly enteredResolve: () => void;
	readonly entered: Promise<void>;
	constructor(private readonly documents: Promise<readonly DocumentSymbolEntry[]>) {
		let resolveEntered!: () => void;
		this.entered = new Promise((resolvePromise) => {
			resolveEntered = resolvePromise;
		});
		this.enteredResolve = resolveEntered;
	}
	findSymbols() {
		return Promise.resolve(symbolSearchResult());
	}
	goToDefinition(_location: WorkspaceLocation): Promise<readonly WorkspaceLocation[]> {
		return Promise.resolve([]);
	}
	documentSymbols(): Promise<readonly DocumentSymbolEntry[]> {
		this.enteredResolve();
		return this.documents;
	}
	outgoingCalls(): Promise<[]> {
		return Promise.resolve([]);
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
}

class InstantIndex implements ClosableSymbolIndex {
	readonly provenance = TEST_SEMANTIC_PROVENANCE;
	async findSymbols() {
		return symbolSearchResult([{ name: "found", kind: "function", location: { path: "index.ts", line: 1, character: 1 } }]);
	}
	async close(): Promise<void> {}
}

let roots: string[] = [];
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots = [];
});

function fixture(): string {
	const directory = mkdtempSync(join(tmpdir(), "lector-fg-admission-"));
	writeFileSync(join(directory, "index.ts"), "export function found() {}\n");
	writeFileSync(join(directory, "tsconfig.json"), "{}");
	roots.push(directory);
	return directory;
}

describe("foreground admission priority over background population", () => {
	it("without a reservation, a background population job holding the sole slot starves a concurrent foreground query for a different workspace -- the live regression", async () => {
		const rootA = fixture();
		const rootB = fixture();
		const documents = deferred<readonly DocumentSymbolEntry[]>();
		const blocked = new BlockedOnDocumentSymbolsIndex(documents.promise);
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			maxActiveSymbolIndexes: 1,
			createSymbolIndex: (rootPath: string, _descriptor: LanguageServerDescriptor) => (rootPath === rootA ? blocked : new InstantIndex()),
		});
		const { workspaceId: workspaceA } = await service.dispatch("workspace.registerPath", { path: rootA });
		const { workspaceId: workspaceB } = await service.dispatch("workspace.registerPath", { path: rootB });

		const { job } = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId: workspaceA, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		// Deterministic: the lease is provably held only once documentSymbols() is actually called --
		// job.status alone can't prove that (it reflects executor scheduling, not lease acquisition).
		await blocked.entered;
		expect((await service.dispatch("job.status", { jobId: job.id })).job.status).toBe("running");

		await expect(service.dispatch("workspace.findSymbols", { workspaceId: workspaceB, query: "found" })).rejects.toBeInstanceOf(WarmIndexCapacityExceeded);

		documents.resolve([]);
	});

	it("with reservedForegroundSlots configured, the same concurrent foreground query is admitted promptly instead of starving", async () => {
		const rootA = fixture();
		const rootB = fixture();
		const documents = deferred<readonly DocumentSymbolEntry[]>();
		const blocked = new BlockedOnDocumentSymbolsIndex(documents.promise);
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			maxActiveSymbolIndexes: 2,
			reservedForegroundSlots: 1,
			createSymbolIndex: (rootPath: string, _descriptor: LanguageServerDescriptor) => (rootPath === rootA ? blocked : new InstantIndex()),
		});
		const { workspaceId: workspaceA } = await service.dispatch("workspace.registerPath", { path: rootA });
		const { workspaceId: workspaceB } = await service.dispatch("workspace.registerPath", { path: rootB });

		const { job } = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId: workspaceA, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		await blocked.entered;
		expect((await service.dispatch("job.status", { jobId: job.id })).job.status).toBe("running");

		const startedAt = Date.now();
		const { symbols } = await service.dispatch("workspace.findSymbols", { workspaceId: workspaceB, query: "found" });
		expect(symbols.map((symbol) => symbol.name)).toContain("found");
		expect(Date.now() - startedAt).toBeLessThan(500); // admitted immediately, never queued behind background

		documents.resolve([]);
	});

	it("cacheStatus reports waiting-for-resources, not caching, once population is itself queued behind a full background ceiling", async () => {
		const rootA = fixture();
		const rootB = fixture();
		const firstDocuments = deferred<readonly DocumentSymbolEntry[]>();
		const blocked = new BlockedOnDocumentSymbolsIndex(firstDocuments.promise);
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			maxActiveSymbolIndexes: 1,
			reservedForegroundSlots: 0,
			backgroundAdmissionQueueTimeoutMs: 2_000,
			createSymbolIndex: (rootPath: string, _descriptor: LanguageServerDescriptor) => (rootPath === rootA ? blocked : new InstantIndex()),
		});
		const { workspaceId: workspaceA } = await service.dispatch("workspace.registerPath", { path: rootA });
		const { workspaceId: workspaceB } = await service.dispatch("workspace.registerPath", { path: rootB });

		const first = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId: workspaceA, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		await blocked.entered;
		expect((await service.dispatch("job.status", { jobId: first.job.id })).job.status).toBe("running");

		// A second background populate, for a different workspace, has no idle victim (workspace A's
		// index is actively leased) and the pool is already at maxActive=1 -- it queues.
		const second = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId: workspaceB, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(await service.dispatch("workspace.cacheStatus", { workspaceId: workspaceB, maxFiles: 10, maxSymbolsPerFile: 10 })).toEqual({
			status: "waiting-for-resources",
			jobId: second.job.id,
		});

		firstDocuments.resolve([]);
	});
});
