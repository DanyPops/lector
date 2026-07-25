import { describe, expect, it } from "bun:test";
import type { JobSnapshot, PopulateSymbolGraphResult } from "@danypops/lector";
import { monitorWorkspaceCache, type WorkspaceCacheOperations } from "../extension/src/workspace-cache-operations.ts";

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
		result: { filesProcessed: 2, symbolsProcessed: 4, nodesAdded: 4, edgesAdded: 2 },
	};
}

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
