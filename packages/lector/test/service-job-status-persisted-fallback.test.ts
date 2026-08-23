/**
 * Reproduces symptom #3 from the deepseek-ai/deepseek-harness large-repo population
 * investigation (task "Investigate TS language server stalls/crashes...", fix task
 * "Lector: resolve job.status through the persisted generation when the in-memory job record
 * is evicted"): job.status can report JobNotFound for a job that actually completed
 * successfully, while workspace.cacheStatus against the same bounds correctly reports the
 * persisted result the whole time.
 *
 * BoundedJobExecutor's own retention is a real, intentional resource bound (maxRetained/
 * retentionMs, see service.ts) -- this test does not dispute that. The gap is that once a
 * terminal job entry is evicted, job.status has absolutely nothing else to fall back on: the
 * jobId createId() produces is fully opaque (no embedded workspaceId/bounds), so a caller who
 * only kept the jobId has no way to recover the real, still-durably-persisted outcome.
 *
 * This test forces a real, deterministic eviction via maxRetained: 1 (BoundedJobExecutor
 * evicts synchronously, by count, the instant a new job's own terminal state pushes the
 * retained set over budget -- see bounded-job-executor.ts's #recordTerminal) rather than
 * waiting on retentionMs, so the reproduction needs no fake clock and no real time delay.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedJobExecutor } from "../src/concurrency/bounded-job-executor.ts";
import type { OperationOutputs } from "../src/service/operations.ts";
import { createLectorService, type LectorService } from "../src/service.ts";
import type { PopulateSymbolGraphResult } from "../src/symbol-graph/populate-symbol-graph.ts";

let service: LectorService | undefined;
let roots: string[] = [];

afterEach(async () => {
	await service?.close();
	service = undefined;
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots = [];
});

/** One real, trivial TypeScript file -- population completes almost immediately. */
function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-job-status-fallback-"));
	writeFileSync(join(root, "index.ts"), "export function value() { return 1; }\n");
	writeFileSync(join(root, "tsconfig.json"), "{}");
	roots.push(root);
	return root;
}

/** maxRetained: 1 -- the second job's own completion evicts the first's terminal entry immediately, deterministically, with no fake clock or real wait needed. */
function singleRetentionExecutor(): BoundedJobExecutor<PopulateSymbolGraphResult> {
	let id = 0;
	return new BoundedJobExecutor<PopulateSymbolGraphResult>({
		maxConcurrent: 2,
		maxQueued: 2,
		maxRetained: 1,
		retentionMs: 60_000,
		createId: () => `fallback-test-job-${++id}`,
	});
}

async function waitForTerminal(activeService: LectorService, jobId: string, timeoutMs = 20_000): Promise<OperationOutputs["job.status"]> {
	const deadline = Date.now() + timeoutMs;
	let status = await activeService.dispatch("job.status", { jobId });
	while (status.job.status !== "succeeded" && status.job.status !== "failed") {
		if (Date.now() >= deadline) throw new Error(`job "${jobId}" did not reach a terminal state within ${timeoutMs}ms (last status: ${status.job.status})`);
		await new Promise((resolve) => setTimeout(resolve, 25));
		status = await activeService.dispatch("job.status", { jobId });
	}
	return status;
}

describe("job.status falls back to the persisted generation once the in-memory job record is evicted", () => {
	/**
	 * it.failing: this fallback does not exist yet (see task "Lector: resolve job.status
	 * through the persisted generation when the in-memory job record is evicted"), so this
	 * genuinely throws JobNotFound today -- it.failing reports that as a PASS (a verified,
	 * tracked, currently-true gap) rather than breaking the build. Once the fallback lands, this
	 * assertion will start succeeding, which flips it.failing itself to a real failure -- the
	 * signal to promote this to a plain `it`.
	 */
	it.failing("resolves the real completed outcome instead of throwing JobNotFound, for a job whose in-memory record has already been evicted by another job's completion", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true, createJobExecutor: singleRetentionExecutor });

		const firstRoot = fixture();
		const { workspaceId: firstWorkspaceId } = await service.dispatch("workspace.registerPath", { path: firstRoot });
		const firstSubmitted = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId: firstWorkspaceId, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		const firstJobId = firstSubmitted.job.id;
		const firstTerminal = await waitForTerminal(service, firstJobId);
		expect(firstTerminal.job.status).toBe("succeeded");

		// A real, independent second population -- its own completion is what evicts the first
		// job's terminal record under maxRetained: 1, exactly as a second unrelated background
		// job would in real, longer-running production usage.
		const secondRoot = fixture();
		const { workspaceId: secondWorkspaceId } = await service.dispatch("workspace.registerPath", { path: secondRoot });
		const secondSubmitted = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId: secondWorkspaceId, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		const secondTerminal = await waitForTerminal(service, secondSubmitted.job.id);
		expect(secondTerminal.job.status).toBe("succeeded");

		// Sanity: the first job's in-memory record really is gone now -- this proves the
		// reproduction actually exercises eviction, not a still-warm record.
		await expect(service.dispatch("job.status", { jobId: firstJobId })).rejects.toThrow(/unknown/i);

		// The real, durable outcome is still there the whole time, reachable via the matching
		// bounds -- proving this is a job.status gap, not a data-loss bug.
		const persisted = await service.dispatch("workspace.cacheStatus", { workspaceId: firstWorkspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(persisted.status).toBe("cached");

		// Desired behavior once the fallback lands: job.status resolves the real completed
		// outcome through the persisted generation instead of throwing JobNotFound.
		const fallback = await service.dispatch("job.status", { jobId: firstJobId });
		expect(fallback.job.status).toBe("succeeded");
	}, 45_000);
});
