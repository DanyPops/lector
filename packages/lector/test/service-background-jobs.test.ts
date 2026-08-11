import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentSymbolEntry } from "../src/code-intelligence/document-symbol.ts";
import { BoundedJobExecutor } from "../src/concurrency/bounded-job-executor.ts";
import type { ClosableSymbolIndex, LectorService } from "../src/service.ts";
import { createLectorService, JobNotFound, JobWaitTooLong } from "../src/service.ts";
import type { PopulateSymbolGraphResult } from "../src/symbol-graph/populate-symbol-graph.ts";
import type { WorkspaceLocation } from "../src/workspace/workspace-symbol.ts";
import { symbolSearchResult, TEST_SEMANTIC_PROVENANCE } from "./support/intelligence-provenance.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class DelayedCodeIndex implements ClosableSymbolIndex {
	readonly provenance = TEST_SEMANTIC_PROVENANCE;

	constructor(
		private readonly documents: Promise<readonly DocumentSymbolEntry[]>,
		private readonly onDocumentSymbols: () => void = () => {},
	) {}
	findSymbols() {
		return Promise.resolve(symbolSearchResult());
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

async function waitForPublished(predicate: () => boolean, timeoutMs = 100): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`event was not published within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
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
		const projectRoot = fixture();
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: projectRoot });
		expect(await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 })).toEqual({
			status: "not-cached",
			reason: "no-completed-generation",
		});

		const submitted = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		expect(submitted.job).toMatchObject({ id: "test-job-1", status: "running", operation: "workspace.populateSymbolGraph", priority: "local" });
		expect(await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 })).toEqual({
			status: "caching",
			jobId: submitted.job.id,
		});

		documents.resolve([]);
		let status = await service.dispatch("job.status", { jobId: submitted.job.id });
		for (let attempt = 0; attempt < 20 && status.job.status !== "succeeded"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1));
			status = await service.dispatch("job.status", { jobId: submitted.job.id });
		}
		expect(status.job).toMatchObject({ status: "succeeded", result: { filesProcessed: 1, symbolsProcessed: 0, nodesAdded: 0, edgesAdded: 0 } });
		const cached = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(cached.status).toBe("cached");
		writeFileSync(join(projectRoot, "index.ts"), "export function answer() { return 43; }\n");
		expect(await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 })).toEqual({
			status: "not-cached",
			reason: "source-changed",
		});
	});

	it("publishes one terminal snapshot on the topic returned by job.watch", async () => {
		const documents = deferred<readonly DocumentSymbolEntry[]>();
		const published: Array<{ topic: string; payload: unknown }> = [];
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createJobExecutor: testExecutor,
			createSymbolIndex: () => new DelayedCodeIndex(documents.promise),
			publish: (topic, payload) => published.push({ topic, payload }),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixture() });
		const { job } = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		const watch = await service.dispatch("job.watch", { jobId: job.id });

		expect(String(watch.watchId)).toBe(`job-watch:${job.id}`);
		expect(String(watch.topic)).toBe(`lector.job.${job.id}`);
		documents.resolve([]);
		await waitForPublished(() => published.length === 1);
		expect(published).toEqual([
			{
				topic: watch.topic,
				payload: { job: expect.objectContaining({ id: job.id, status: "succeeded" }) },
			},
		]);
	});

	it("does not record a cached generation when source files change during population", async () => {
		const documents = deferred<readonly DocumentSymbolEntry[]>();
		const populationStarted = deferred<void>();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createJobExecutor: testExecutor,
			createSymbolIndex: () => new DelayedCodeIndex(documents.promise, () => populationStarted.resolve()),
		});
		const projectRoot = fixture();
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: projectRoot });
		const { job } = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		await populationStarted.promise;
		writeFileSync(join(projectRoot, "index.ts"), "export function changed() { return 99; }\n");
		documents.resolve([]);

		let final = await service.dispatch("job.status", { jobId: job.id });
		for (let attempt = 0; attempt < 20 && final.job.status !== "failed"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1));
			final = await service.dispatch("job.status", { jobId: job.id });
		}
		expect(final.job).toMatchObject({ status: "failed", error: { code: "WorkspaceChangedDuringPopulation" } });
		expect(await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 })).toEqual({
			status: "not-cached",
			reason: "no-completed-generation",
		});
	});

	it("retries once and succeeds once the interfering change has already settled by the next attempt -- retryTimeBudgetMs opt-in, distinct from today's fail-fast default", async () => {
		const documents = deferred<readonly DocumentSymbolEntry[]>();
		const populationStarted = deferred<void>();
		let documentSymbolsCalls = 0;
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createJobExecutor: testExecutor,
			createSymbolIndex: () =>
				new DelayedCodeIndex(documents.promise, () => {
					documentSymbolsCalls++;
					populationStarted.resolve();
				}),
			// Instant in tests -- the real 500ms production settle delay would otherwise slow every run.
			populateRetrySleep: async () => {},
		});
		const projectRoot = fixture();
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: projectRoot });
		const { job } = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10, retryTimeBudgetMs: 60_000 },
			waitMs: 0,
		});
		await populationStarted.promise;
		// Perturbs the workspace exactly once, during the first attempt's own population window --
		// the exact live race (an in-flight reference-based rename) this retry is meant to absorb.
		writeFileSync(join(projectRoot, "index.ts"), "export function changed() { return 99; }\n");
		documents.resolve([]);

		let final = await service.dispatch("job.status", { jobId: job.id });
		for (let attempt = 0; attempt < 50 && final.job.status !== "succeeded" && final.job.status !== "failed"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1));
			final = await service.dispatch("job.status", { jobId: job.id });
		}
		expect(final.job.status).toBe("succeeded");
		// Two real attempts happened -- the first raced and recorded nothing, the second (against the
		// now-settled file) succeeded and actually recorded a generation.
		expect(documentSymbolsCalls).toBe(2);
		expect(await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 })).toMatchObject({ status: "cached" });
	});

	it("still fails with WorkspaceChangedDuringPopulation once the retry budget is exhausted against a workspace that keeps changing every attempt", async () => {
		let fakeNow = 0;
		let attempts = 0;
		const projectRootRef: { current: string | undefined } = { current: undefined };
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createJobExecutor: testExecutor,
			createSymbolIndex: () =>
				new DelayedCodeIndex(Promise.resolve([]), () => {
					attempts++;
					// Perturbs the workspace on every single attempt, during its own population window --
					// a workspace under continuous active editing that never lets a population converge.
					if (projectRootRef.current) writeFileSync(join(projectRootRef.current, "index.ts"), `export function v${attempts}() { return ${attempts}; }\n`);
				}),
			populateRetrySleep: async () => {},
			// Advances 1000ms per call -- deterministic budget exhaustion with no real wall-clock wait.
			populateRetryNow: () => {
				const value = fakeNow;
				fakeNow += 1000;
				return value;
			},
		});
		const projectRoot = fixture();
		projectRootRef.current = projectRoot;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: projectRoot });
		const { job } = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10, retryTimeBudgetMs: 3_000 },
			waitMs: 0,
		});

		let final = await service.dispatch("job.status", { jobId: job.id });
		for (let attempt = 0; attempt < 50 && final.job.status !== "failed"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1));
			final = await service.dispatch("job.status", { jobId: job.id });
		}
		expect(final.job).toMatchObject({ status: "failed", error: { code: "WorkspaceChangedDuringPopulation" } });
		// More than one attempt actually happened (the retry loop ran, not a single immediate throw),
		// but it terminated once the injected clock exceeded the 3000ms budget rather than looping forever.
		expect(attempts).toBeGreaterThan(1);
		expect(await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 })).toEqual({
			status: "not-cached",
			reason: "no-completed-generation",
		});
	});

	it("rejects an out-of-bound retryTimeBudgetMs on the direct (non-job) dispatch path before doing any real work", async () => {
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: () => new DelayedCodeIndex(Promise.resolve([])),
		});
		const projectRoot = fixture();
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: projectRoot });

		await expect(
			service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10, retryTimeBudgetMs: -1 }),
		).rejects.toThrow(/retryTimeBudgetMs/);
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
				fetch: () =>
					Promise.resolve({
						path: remoteRoot,
						fromCache: true,
						resolvedRef: "main",
						refFallbackOccurred: false,
						commit: "1111111111111111111111111111111111111111",
					}),
				resolveRemoteCommit: () => Promise.resolve(undefined),
				listCached: () => Promise.resolve([]),
				evict: () => Promise.resolve(false),
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

	it("job status and watch explain an unknown/process-expired id instead of returning an empty result", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true, createJobExecutor: testExecutor });
		await expect(service.dispatch("job.status", { jobId: "previous-process-job" })).rejects.toBeInstanceOf(JobNotFound);
		await expect(service.dispatch("job.watch", { jobId: "previous-process-job" })).rejects.toBeInstanceOf(JobNotFound);
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
