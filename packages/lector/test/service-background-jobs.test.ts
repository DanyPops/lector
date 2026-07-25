import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedJobExecutor } from "../src/domain/bounded-job-executor.ts";
import type { DocumentSymbolEntry } from "../src/domain/document-symbol.ts";
import type { PopulateSymbolGraphResult } from "../src/domain/populate-symbol-graph.ts";
import type { WorkspaceLocation, WorkspaceSymbol } from "../src/domain/workspace-symbol.ts";
import type { ClosableSymbolIndex, LectorService } from "../src/service.ts";
import { createLectorService, JobNotFound, JobWaitTooLong } from "../src/service.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class DelayedCodeIndex implements ClosableSymbolIndex {
	constructor(
		private readonly documents: Promise<readonly DocumentSymbolEntry[]>,
		private readonly onDocumentSymbols: () => void = () => {},
	) {}
	findSymbols(_query: string): Promise<WorkspaceSymbol[]> {
		return Promise.resolve([]);
	}
	goToDefinition(_location: WorkspaceLocation): Promise<readonly WorkspaceLocation[]> {
		return Promise.resolve([]);
	}
	documentSymbols(_path: string): Promise<readonly DocumentSymbolEntry[]> {
		this.onDocumentSymbols();
		return this.documents;
	}
	outgoingCalls(): Promise<[]> {
		return Promise.resolve([]);
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
}

let root: string | undefined;
const extraRoots: string[] = [];
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	for (const extraRoot of extraRoots.splice(0)) rmSync(extraRoot, { recursive: true, force: true });
});

function fixture(trackAsPrimary = true): string {
	const directory = mkdtempSync(join(tmpdir(), "lector-job-service-"));
	writeFileSync(join(directory, "index.ts"), "export function answer() { return 42; }\n");
	writeFileSync(join(directory, "tsconfig.json"), "{}");
	if (trackAsPrimary) root = directory;
	else extraRoots.push(directory);
	return directory;
}

function testExecutor(): BoundedJobExecutor<PopulateSymbolGraphResult> {
	let id = 0;
	return new BoundedJobExecutor<PopulateSymbolGraphResult>({
		maxConcurrent: 1,
		maxQueued: 2,
		maxRetained: 4,
		retentionMs: 60_000,
		createId: () => `test-job-${++id}`,
	});
}

describe("createLectorService background jobs", () => {
	it("job.submit returns before populateSymbolGraph finishes, and job.status later returns its real result", async () => {
		const documents = deferred<readonly DocumentSymbolEntry[]>();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createJobExecutor: testExecutor,
			createSymbolIndex: () => new DelayedCodeIndex(documents.promise),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixture() });

		const submitted = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		expect(submitted.job).toMatchObject({ id: "test-job-1", status: "running", operation: "workspace.populateSymbolGraph", priority: "local" });

		documents.resolve([]);
		let status = await service.dispatch("job.status", { jobId: submitted.job.id });
		for (let attempt = 0; attempt < 20 && status.job.status !== "succeeded"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1));
			status = await service.dispatch("job.status", { jobId: submitted.job.id });
		}
		expect(status.job).toMatchObject({ status: "succeeded", result: { filesProcessed: 1, symbolsProcessed: 0, nodesAdded: 0, edgesAdded: 0 } });
	});

	it("bounded initial wait returns a completed fast job without forcing a poll", async () => {
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createJobExecutor: testExecutor,
			createSymbolIndex: () => new DelayedCodeIndex(Promise.resolve([])),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixture() });

		const submitted = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 100,
		});
		expect(submitted.job.status).toBe("succeeded");
	});

	it("starts queued local workspace work before older fetched-repo work", async () => {
		const blockerRoot = fixture();
		const remoteRoot = fixture(false);
		const localRoot = fixture(false);
		const gates = new Map([
			[blockerRoot, deferred<readonly DocumentSymbolEntry[]>()],
			[remoteRoot, deferred<readonly DocumentSymbolEntry[]>()],
			[localRoot, deferred<readonly DocumentSymbolEntry[]>()],
		]);
		const started: string[] = [];
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createJobExecutor: testExecutor,
			createRepoFetcher: () => ({
				fetch: () => Promise.resolve({ path: remoteRoot, fromCache: true, resolvedRef: "main", refFallbackOccurred: false }),
			}),
			createSymbolIndex: (rootPath) => {
				const gate = gates.get(rootPath);
				if (!gate) throw new Error(`missing test gate for ${rootPath}`);
				return new DelayedCodeIndex(gate.promise, () => started.push(rootPath));
			},
		});
		const { workspaceId: blockerId } = await service.dispatch("workspace.registerPath", { path: blockerRoot });
		const { workspaceId: localId } = await service.dispatch("workspace.registerPath", { path: localRoot });
		const { workspaceId: remoteId } = await service.dispatch("repo.fetch", { host: "example.test", owner: "owner", repo: "repo", ref: null });
		const submit = (workspaceId: string) =>
			service?.dispatch("job.submit", {
				operation: "workspace.populateSymbolGraph",
				input: { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 },
				waitMs: 0,
			});

		await submit(blockerId);
		await submit(remoteId);
		await submit(localId);
		for (let attempt = 0; attempt < 20 && started.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
		expect(started).toEqual([blockerRoot]);
		gates.get(blockerRoot)?.resolve([]);
		for (let attempt = 0; attempt < 20 && started.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
		expect(started).toEqual([blockerRoot, localRoot]);

		gates.get(localRoot)?.resolve([]);
		gates.get(remoteRoot)?.resolve([]);
	});

	it("job.status explains an unknown/process-expired id instead of returning an empty result", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true, createJobExecutor: testExecutor });
		await expect(service.dispatch("job.status", { jobId: "previous-process-job" })).rejects.toBeInstanceOf(JobNotFound);
	});

	it("rejects an initial wait above the service bound", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true, createJobExecutor: testExecutor });
		await expect(
			service.dispatch("job.submit", {
				operation: "workspace.populateSymbolGraph",
				input: { workspaceId: "unused", maxFiles: 10, maxSymbolsPerFile: 10 },
				waitMs: 30_001,
			}),
		).rejects.toBeInstanceOf(JobWaitTooLong);
	});
});
