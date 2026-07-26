import { describe, expect, it } from "bun:test";
import type { JobSnapshot, PopulateSymbolGraphResult } from "@danypops/lector";
import { cacheContextMessage, describeCacheState, monitorWorkspaceCache, type WorkspaceCacheOperations } from "../extension/src/workspace-cache-operations.ts";

function runningJob(id = "job-1"): JobSnapshot<PopulateSymbolGraphResult> {
	return { id, operation: "workspace.populateSymbolGraph", priority: "local", submittedAt: 1, startedAt: 2, status: "running" };
}

function succeededJob(id = "job-1"): JobSnapshot<PopulateSymbolGraphResult> & { status: "succeeded" } {
	return {
		id,
		operation: "workspace.populateSymbolGraph",
		priority: "local",
		submittedAt: 1,
		startedAt: 2,
		finishedAt: 3,
		status: "succeeded",
		result: {
			completeness: "complete",
			filesAttempted: 2,
			filesProcessed: 2,
			filesFailed: 0,
			symbolsProcessed: 4,
			nodesAdded: 4,
			edgesAdded: 2,
			failureCount: 0,
			failures: [],
			failuresTruncated: false,
		},
	};
}

function partialJob(id = "job-2"): JobSnapshot<PopulateSymbolGraphResult> & { status: "succeeded" } {
	const job = succeededJob(id);
	return {
		...job,
		result: {
			...job.result,
			completeness: "partial",
			filesAttempted: 3,
			filesFailed: 1,
			failureCount: 1,
			failures: [
				{
					path: "/repo/excluded_test.go",
					operation: "document-symbols",
					code: "CodeIntelligenceFileError",
					message: "no package metadata",
					provenance: {
						fidelity: "semantic",
						backend: "gopls",
						languageId: "go",
						authority: "language-server",
						freshness: "live-process",
						limitations: [],
					},
				},
			],
		},
	};
}

describe("cache status presentation", () => {
	it("never claims a cached graph is still loading", () => {
		const state = { status: "cached" } as const;
		expect(describeCacheState(state)).toBe("cached");
		expect(cacheContextMessage(state)).toBe("Lector workspace cache: cached. The cached graph is ready.");
		expect(cacheContextMessage(state)).not.toContain("loading");
	});

	it("keeps the bounded job id and live-operation guidance while caching", () => {
		const state = { status: "caching", jobId: "job-42" } as const;
		expect(cacheContextMessage(state)).toBe(
			"Lector workspace cache: caching (job job-42). The cached graph is still building; use live code-intelligence operations until it is ready.",
		);
	});

	it("does not claim that work is running before a cache job is observed", () => {
		const state = { status: "not-cached", reason: "source-changed" } as const;
		expect(cacheContextMessage(state)).toBe("Lector workspace cache: not cached (source-changed). Live code-intelligence operations remain available.");
	});

	it("reports a completed cache job as ready", () => {
		const state = { status: "finished-caching", job: succeededJob("job-42") } as const;
		expect(cacheContextMessage(state)).toBe("Lector workspace cache: finished caching (job job-42). The cached graph is ready.");
	});

	it("keeps partial caches distinct and directs failed files to live operations", () => {
		const state = { status: "partial", result: partialJob().result } as const;
		expect(describeCacheState(state)).toBe("partially cached (1 failed file)");
		expect(cacheContextMessage(state)).toBe(
			"Lector workspace cache: partially cached (1 failed file). The graph is usable, but live code-intelligence operations are required for failed files.",
		);
	});
});

describe("monitorWorkspaceCache", () => {
	it("reports cached without submitting work when the content manifest still matches", async () => {
		let submissions = 0;
		const states: string[] = [];
		const operations: WorkspaceCacheOperations = {
			status: () =>
				Promise.resolve({
					status: "cached",
					generation: { sourceFingerprint: "x", maxFiles: 10, maxSymbolsPerFile: 10, completedAt: 1, result: succeededJob().result },
				}),
			submit: () => {
				submissions++;
				return Promise.resolve(runningJob());
			},
			jobStatus: () => Promise.resolve(succeededJob()),
		};
		await monitorWorkspaceCache(operations, {
			directory: "/repo",
			maxFiles: 10,
			maxSymbolsPerFile: 10,
			pollIntervalMs: 1,
			maxPolls: 2,
			shouldContinue: () => true,
			onState: (state) => states.push(state.status),
		});
		expect(states).toEqual(["cached"]);
		expect(submissions).toBe(0);
	});

	it("reports not-cached, caching, finished-caching, then cached around one real job lifecycle", async () => {
		const states: string[] = [];
		let polls = 0;
		const operations: WorkspaceCacheOperations = {
			status: () => Promise.resolve({ status: "not-cached", reason: "source-changed" }),
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () => Promise.resolve(++polls === 1 ? runningJob() : succeededJob()),
		};
		await monitorWorkspaceCache(operations, {
			directory: "/repo",
			maxFiles: 10,
			maxSymbolsPerFile: 10,
			pollIntervalMs: 1,
			maxPolls: 3,
			shouldContinue: () => true,
			onState: (state) => states.push(state.status),
			sleep: () => Promise.resolve(),
		});
		expect(states).toEqual(["not-cached", "caching", "finished-caching", "cached"]);
	});

	it("retains a completed partial generation without resubmitting it", async () => {
		let submissions = 0;
		const states: string[] = [];
		const job = partialJob();
		const operations: WorkspaceCacheOperations = {
			status: () =>
				Promise.resolve({
					status: "partial",
					generation: { sourceFingerprint: "x", maxFiles: 10, maxSymbolsPerFile: 10, completedAt: 1, result: job.result },
				}),
			submit: () => {
				submissions++;
				return Promise.resolve(job);
			},
			jobStatus: () => Promise.resolve(job),
		};
		await monitorWorkspaceCache(operations, {
			directory: "/repo",
			maxFiles: 10,
			maxSymbolsPerFile: 10,
			pollIntervalMs: 1,
			maxPolls: 2,
			shouldContinue: () => true,
			onState: (state) => states.push(state.status),
		});
		expect(states).toEqual(["partial"]);
		expect(submissions).toBe(0);
	});

	it("reports a new partial generation after its job succeeds", async () => {
		const states: string[] = [];
		const job = partialJob();
		const operations: WorkspaceCacheOperations = {
			status: () => Promise.resolve({ status: "not-cached", reason: "source-changed" }),
			submit: () => Promise.resolve(job),
			jobStatus: () => Promise.resolve(job),
		};
		await monitorWorkspaceCache(operations, {
			directory: "/repo",
			maxFiles: 10,
			maxSymbolsPerFile: 10,
			pollIntervalMs: 1,
			maxPolls: 2,
			shouldContinue: () => true,
			onState: (state) => states.push(state.status),
		});
		expect(states).toEqual(["not-cached", "finished-caching", "partial"]);
	});

	it("stops after maxPolls instead of polling forever", async () => {
		let polls = 0;
		const operations: WorkspaceCacheOperations = {
			status: () => Promise.resolve({ status: "caching", jobId: "job-1" }),
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () => {
				polls++;
				return Promise.resolve(runningJob());
			},
		};
		await monitorWorkspaceCache(operations, {
			directory: "/repo",
			maxFiles: 10,
			maxSymbolsPerFile: 10,
			pollIntervalMs: 1,
			maxPolls: 2,
			shouldContinue: () => true,
			onState: () => {},
			sleep: () => Promise.resolve(),
		});
		expect(polls).toBe(2);
	});
});
