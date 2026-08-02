import { describe, expect, it } from "bun:test";
import type { JobSnapshot, PopulateSymbolGraphResult, WorkspaceCacheStatus } from "@danypops/lector";
import type { LectorTheme } from "../extension/src/lector-tui-theme.ts";
import { formatJobSnapshotResult, formatWorkspaceCacheCall, formatWorkspaceCacheStatusResult } from "../extension/src/workspace-cache-rendering.ts";

const theme: LectorTheme = { fg: (_color, text) => text, bold: (text) => text };

function succeededResult(overrides: Partial<PopulateSymbolGraphResult> = {}): PopulateSymbolGraphResult {
	return {
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
		...overrides,
	};
}

describe("formatWorkspaceCacheCall", () => {
	it("renders a status call with the directory", () => {
		const text = formatWorkspaceCacheCall("status", { directory: "/repo" }, theme);
		expect(text).toContain("workspace_cache");
		expect(text).toContain("status");
		expect(text).toContain("/repo");
	});

	it("renders a populate call with the directory and bounds when given", () => {
		const text = formatWorkspaceCacheCall("populate", { directory: "/repo", maxFiles: 2000, maxSymbolsPerFile: 200 }, theme);
		expect(text).toContain("populate");
		expect(text).toContain("/repo");
		expect(text).toContain("2000");
	});

	it("renders a job_status call with the jobId, not a directory", () => {
		const text = formatWorkspaceCacheCall("job_status", { jobId: "job-42" }, theme);
		expect(text).toContain("job_status");
		expect(text).toContain("job-42");
	});
});

describe("formatWorkspaceCacheStatusResult", () => {
	it("renders not-cached with its reason", () => {
		const status: WorkspaceCacheStatus = { status: "not-cached", reason: "source-changed" };
		expect(formatWorkspaceCacheStatusResult(status, theme)).toContain("source-changed");
	});

	it("renders caching with the in-flight jobId, so a caller knows what to poll", () => {
		const status: WorkspaceCacheStatus = { status: "caching", jobId: "job-7" };
		expect(formatWorkspaceCacheStatusResult(status, theme)).toContain("job-7");
	});

	it("renders cached with the generation's file/symbol counts", () => {
		const status: WorkspaceCacheStatus = {
			status: "cached",
			generation: { sourceFingerprint: "x", maxFiles: 500, maxSymbolsPerFile: 100, completedAt: 1, result: succeededResult() },
		};
		const text = formatWorkspaceCacheStatusResult(status, theme);
		expect(text).toContain("cached");
		expect(text).toContain("2");
	});

	it("renders partial distinctly from cached, with the failed-file count", () => {
		const status: WorkspaceCacheStatus = {
			status: "partial",
			generation: {
				sourceFingerprint: "x",
				maxFiles: 500,
				maxSymbolsPerFile: 100,
				completedAt: 1,
				result: succeededResult({ completeness: "partial", filesFailed: 3, failureCount: 3 }),
			},
		};
		const text = formatWorkspaceCacheStatusResult(status, theme);
		expect(text).toContain("partial");
		expect(text).toContain("3");
	});

	it("falls back to a dim placeholder when there is no result at all", () => {
		expect(formatWorkspaceCacheStatusResult(undefined, theme)).toBe("No result.");
	});
});

describe("formatJobSnapshotResult", () => {
	function baseJob(status: JobSnapshot<PopulateSymbolGraphResult>["status"]): JobSnapshot<PopulateSymbolGraphResult> {
		if (status === "queued") return { id: "job-1", operation: "workspace.populateSymbolGraph", priority: "local", submittedAt: 1, status };
		if (status === "running") return { id: "job-1", operation: "workspace.populateSymbolGraph", priority: "local", submittedAt: 1, startedAt: 2, status };
		if (status === "succeeded") {
			return {
				id: "job-1",
				operation: "workspace.populateSymbolGraph",
				priority: "local",
				submittedAt: 1,
				startedAt: 2,
				finishedAt: 3,
				status,
				result: succeededResult(),
			};
		}
		return {
			id: "job-1",
			operation: "workspace.populateSymbolGraph",
			priority: "local",
			submittedAt: 1,
			finishedAt: 3,
			status: "failed",
			error: { code: "SomeError", message: "it broke" },
		};
	}

	it("renders queued and running distinctly, both naming the jobId to poll", () => {
		const queued = formatJobSnapshotResult(baseJob("queued"), theme);
		const running = formatJobSnapshotResult(baseJob("running"), theme);
		expect(queued).toContain("job-1");
		expect(queued).toContain("queued");
		expect(running).toContain("job-1");
		expect(running).toContain("running");
		expect(queued).not.toBe(running);
	});

	it("renders succeeded with the real result counts, not just a bare 'done'", () => {
		const text = formatJobSnapshotResult(baseJob("succeeded"), theme);
		expect(text).toContain("succeeded");
		expect(text).toContain("2"); // filesProcessed
		expect(text).toContain("4"); // symbolsProcessed
	});

	it("renders failed with the real error code and message, not a generic failure string", () => {
		const text = formatJobSnapshotResult(baseJob("failed"), theme);
		expect(text).toContain("SomeError");
		expect(text).toContain("it broke");
	});

	it("falls back to a dim placeholder when there is no job at all", () => {
		expect(formatJobSnapshotResult(undefined, theme)).toBe("No result.");
	});
});
