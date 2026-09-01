import { describe, expect, it } from "bun:test";
import type { CacheGenerationSummary, JobSnapshot, PopulateSymbolGraphResult } from "@danypops/lector";
import {
	cacheContextMessage,
	describeCacheState,
	monitorWorkspaceCache,
	type WorkspaceCacheMonitorOperations as WorkspaceCacheOperations,
	waitForJobCompletion,
} from "../../extension/src/workspace-cache/operations.ts";

function runningJob(id = "job-1"): JobSnapshot<PopulateSymbolGraphResult> {
	return { id, operation: "workspace.populateSymbolGraph", priority: "local", submittedAt: 1, startedAt: 2, status: "running" };
}

/** Builds the compact wire-level generation shape workspace.cacheStatus actually returns, from a full raw PopulateSymbolGraphResult -- test fixtures build the raw result once and derive this, mirroring what summarizeCacheGeneration does server-side. */
function cacheGeneration(result: PopulateSymbolGraphResult): CacheGenerationSummary {
	return {
		completedAt: 1,
		maxFiles: 10,
		maxSymbolsPerFile: 10,
		walkedFileCount: result.filesProcessed,
		result: {
			completeness: result.completeness,
			filesAttempted: result.filesAttempted,
			filesProcessed: result.filesProcessed,
			filesFailed: result.filesFailed,
			symbolsProcessed: result.symbolsProcessed,
			nodesAdded: result.nodesAdded,
			edgesAdded: result.edgesAdded,
			failureCount: result.failureCount,
			failureSummary: result.failures.map((failure) => ({
				path: failure.path,
				operation: failure.operation,
				code: failure.code,
				message: failure.message,
				count: 1,
			})),
			failureSummaryTruncated: result.failuresTruncated,
		},
	};
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

describe("waitForJobCompletion", () => {
	it("finishes from a pushed terminal snapshot without waiting for a fallback poll", async () => {
		let listener: ((job: JobSnapshot<PopulateSymbolGraphResult>) => void) | undefined;
		let polls = 0;
		let sleeps = 0;
		const operations: WorkspaceCacheOperations = {
			status: () => Promise.resolve({ status: "caching", jobId: "job-1" }),
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () => {
				polls++;
				return Promise.resolve(runningJob());
			},
			watchJob: (_jobId, onJob) => {
				listener = onJob;
				return Promise.resolve({ status: "subscribed", handle: { close() {} } });
			},
		};

		const completion = waitForJobCompletion(operations, "job-1", {
			pollIntervalMs: 100,
			maxPolls: 2,
			shouldContinue: () => true,
			sleep: () => {
				sleeps++;
				return new Promise<void>(() => {});
			},
		});
		await Promise.resolve();
		listener?.(succeededJob());

		expect(await completion).toMatchObject({ kind: "terminal", job: { status: "succeeded" } });
		expect(polls).toBe(1);
		expect(sleeps).toBe(1);
	});

	it("closes the push subscription immediately when the wait is canceled", async () => {
		const controller = new AbortController();
		let closed = false;
		let polls = 0;
		const operations: WorkspaceCacheOperations = {
			status: () => Promise.resolve({ status: "caching", jobId: "job-1" }),
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () => {
				polls++;
				return Promise.resolve(runningJob());
			},
			watchJob: () => Promise.resolve({ status: "subscribed", handle: { close: () => (closed = true) } }),
		};
		controller.abort();

		expect(
			await waitForJobCompletion(operations, "job-1", {
				pollIntervalMs: 100,
				maxPolls: 2,
				shouldContinue: () => true,
				signal: controller.signal,
			}),
		).toEqual({ kind: "canceled" });
		expect(closed).toBe(true);
		expect(polls).toBe(0);
	});

	it("falls back to bounded status polling when the push channel is unavailable", async () => {
		let polls = 0;
		const operations: WorkspaceCacheOperations = {
			status: () => Promise.resolve({ status: "caching", jobId: "job-1" }),
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () => Promise.resolve(++polls === 1 ? runningJob() : succeededJob()),
			watchJob: () => Promise.resolve({ status: "unavailable" }),
		};

		const outcome = await waitForJobCompletion(operations, "job-1", {
			pollIntervalMs: 1,
			maxPolls: 2,
			shouldContinue: () => true,
			sleep: () => Promise.resolve(),
		});

		expect(outcome).toMatchObject({ kind: "terminal", job: { status: "succeeded" } });
		expect(polls).toBe(2);
	});

	it("reports job-not-found rather than throwing when the job id has expired, been evicted, or survives a daemon restart", async () => {
		const operations: WorkspaceCacheOperations = {
			status: () => Promise.resolve({ status: "caching", jobId: "job-1" }),
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () =>
				Promise.reject(new Error('JobNotFound: background job "job-1" is unknown: it expired, was evicted, or belonged to a previous daemon process')),
			watchJob: () => Promise.resolve({ status: "unavailable" }),
		};

		const outcome = await waitForJobCompletion(operations, "job-1", {
			pollIntervalMs: 1,
			maxPolls: 2,
			shouldContinue: () => true,
			sleep: () => Promise.resolve(),
		});

		expect(outcome).toEqual({ kind: "job-not-found" });
	});

	it("reports transport-failed rather than throwing when the daemon can't be reached at all", async () => {
		const transportError = new Error("fetch failed");
		const operations: WorkspaceCacheOperations = {
			status: () => Promise.resolve({ status: "caching", jobId: "job-1" }),
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () => Promise.reject(transportError),
			watchJob: () => Promise.resolve({ status: "unavailable" }),
		};

		const outcome = await waitForJobCompletion(operations, "job-1", {
			pollIntervalMs: 1,
			maxPolls: 2,
			shouldContinue: () => true,
			sleep: () => Promise.resolve(),
		});

		expect(outcome).toEqual({ kind: "transport-failed", error: transportError });
	});

	it("reports timed-out, not a terminal job, when the bounded poll budget is spent and the job is still running", async () => {
		const operations: WorkspaceCacheOperations = {
			status: () => Promise.resolve({ status: "caching", jobId: "job-1" }),
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () => Promise.resolve(runningJob()),
			watchJob: () => Promise.resolve({ status: "unavailable" }),
		};

		const outcome = await waitForJobCompletion(operations, "job-1", {
			pollIntervalMs: 1,
			maxPolls: 2,
			shouldContinue: () => true,
			sleep: () => Promise.resolve(),
		});

		expect(outcome).toEqual({ kind: "timed-out" });
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
					generation: cacheGeneration(succeededJob().result),
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
					generation: cacheGeneration(job.result),
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

	it("stops after bounded fallback intervals and one final status check -- still genuinely caching is reported honestly, not silently dropped", async () => {
		let polls = 0;
		const states: string[] = [];
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
			onState: (state) => states.push(state.status),
			sleep: () => Promise.resolve(),
		});
		expect(polls).toBe(3);
		expect(states).toEqual(["caching", "caching"]);
	});

	it("reconciles a timed-out watch against authoritative status, never leaving the UI stuck at caching once the graph actually finished", async () => {
		const states: string[] = [];
		const job = succeededJob();
		let statusCalls = 0;
		const operations: WorkspaceCacheOperations = {
			status: () => {
				statusCalls++;
				return Promise.resolve(statusCalls === 1 ? { status: "caching", jobId: "job-1" } : { status: "cached", generation: cacheGeneration(job.result) });
			},
			submit: () => Promise.resolve(runningJob()),
			// The watch itself never observes the terminal transition -- only the fresh status() call does, simulating
			// another session/process completing the same generation while this bounded watch was still polling.
			jobStatus: () => Promise.resolve(runningJob()),
		};
		await monitorWorkspaceCache(operations, {
			directory: "/repo",
			maxFiles: 10,
			maxSymbolsPerFile: 10,
			pollIntervalMs: 1,
			maxPolls: 1,
			shouldContinue: () => true,
			onState: (state) => states.push(state.status),
			sleep: () => Promise.resolve(),
		});
		expect(states).toEqual(["caching", "cached"]);
		expect(states.at(-1)).not.toBe("caching");
	});

	it("reconciles a job-not-found watch against authoritative status instead of throwing or freezing on a stale message", async () => {
		const states: string[] = [];
		const job = partialJob();
		let statusCalls = 0;
		const operations: WorkspaceCacheOperations = {
			status: () => {
				statusCalls++;
				return Promise.resolve(statusCalls === 1 ? { status: "caching", jobId: "job-1" } : { status: "partial", generation: cacheGeneration(job.result) });
			},
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () =>
				Promise.reject(new Error('JobNotFound: background job "job-1" is unknown: it expired, was evicted, or belonged to a previous daemon process')),
		};
		await monitorWorkspaceCache(operations, {
			directory: "/repo",
			maxFiles: 10,
			maxSymbolsPerFile: 10,
			pollIntervalMs: 1,
			maxPolls: 2,
			shouldContinue: () => true,
			onState: (state) => states.push(state.status),
			sleep: () => Promise.resolve(),
		});
		expect(states).toEqual(["caching", "partial"]);
	});

	it("reconciles a job-not-found watch all the way to not-cached when the source itself changed underneath it", async () => {
		const states: string[] = [];
		let statusCalls = 0;
		const operations: WorkspaceCacheOperations = {
			status: () => {
				statusCalls++;
				return Promise.resolve(statusCalls === 1 ? { status: "caching", jobId: "job-1" } : { status: "not-cached", reason: "source-changed" });
			},
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () =>
				Promise.reject(new Error('JobNotFound: background job "job-1" is unknown: it expired, was evicted, or belonged to a previous daemon process')),
		};
		await monitorWorkspaceCache(operations, {
			directory: "/repo",
			maxFiles: 10,
			maxSymbolsPerFile: 10,
			pollIntervalMs: 1,
			maxPolls: 2,
			shouldContinue: () => true,
			onState: (state) => states.push(state.status),
			sleep: () => Promise.resolve(),
		});
		expect(states).toEqual(["caching", "not-cached"]);
	});

	it("reconciles a transport-failed watch against authoritative status too, not just job-not-found and timed-out", async () => {
		const states: string[] = [];
		let jobStatusCalls = 0;
		let statusCalls = 0;
		const operations: WorkspaceCacheOperations = {
			status: () => {
				statusCalls++;
				return Promise.resolve(
					statusCalls === 1 ? { status: "caching", jobId: "job-1" } : { status: "cached", generation: cacheGeneration(succeededJob().result) },
				);
			},
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () => {
				jobStatusCalls++;
				return Promise.reject(new Error("fetch failed"));
			},
		};
		await monitorWorkspaceCache(operations, {
			directory: "/repo",
			maxFiles: 10,
			maxSymbolsPerFile: 10,
			pollIntervalMs: 1,
			maxPolls: 2,
			shouldContinue: () => true,
			onState: (state) => states.push(state.status),
			sleep: () => Promise.resolve(),
		});
		expect(states).toEqual(["caching", "cached"]);
		expect(jobStatusCalls).toBeGreaterThan(0);
	});

	it("propagates a genuine reconciliation failure rather than swallowing it -- there is nothing more authoritative left to ask", async () => {
		const reconcileError = new Error("daemon unreachable");
		let statusCalls = 0;
		const operations: WorkspaceCacheOperations = {
			status: () => {
				statusCalls++;
				if (statusCalls === 1) return Promise.resolve({ status: "caching", jobId: "job-1" });
				return Promise.reject(reconcileError);
			},
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () => Promise.reject(new Error("fetch failed")),
		};
		await expect(
			monitorWorkspaceCache(operations, {
				directory: "/repo",
				maxFiles: 10,
				maxSymbolsPerFile: 10,
				pollIntervalMs: 1,
				maxPolls: 2,
				shouldContinue: () => true,
				onState: () => {},
				sleep: () => Promise.resolve(),
			}),
		).rejects.toBe(reconcileError);
	});

	it("does not reconcile at all when the monitor stops because the caller genuinely canceled it", async () => {
		const states: string[] = [];
		let statusCalls = 0;
		const operations: WorkspaceCacheOperations = {
			status: () => {
				statusCalls++;
				return Promise.resolve({ status: "caching", jobId: "job-1" });
			},
			submit: () => Promise.resolve(runningJob()),
			jobStatus: () => Promise.resolve(runningJob()),
		};
		let stillRunning = true;
		await monitorWorkspaceCache(operations, {
			directory: "/repo",
			maxFiles: 10,
			maxSymbolsPerFile: 10,
			pollIntervalMs: 1,
			maxPolls: 5,
			shouldContinue: () => stillRunning,
			onState: (state) => {
				states.push(state.status);
				stillRunning = false;
			},
			sleep: () => Promise.resolve(),
		});
		expect(states).toEqual(["caching"]);
		expect(statusCalls).toBe(1);
	});
});
