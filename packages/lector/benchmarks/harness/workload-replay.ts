/**
 * Replays a sequence of real Lector operations against a workload corpus, verifying each
 * step's own correctness before its timing is ever treated as valid -- a step whose result
 * fails verification never contributes a trusted BenchmarkRunResult, regardless of how fast it
 * ran. This is the harness `benchmarks/language-server-cold-start.ts` and
 * `test/performance/*.perf.test.ts` were still missing: exercising actual operations
 * end-to-end (population, search, localization, raw read/edit) rather than isolated loops.
 */
import { runBenchmarkCase, type BenchmarkRunResult } from "./benchmark-runner.ts";

export interface WorkloadStep<T = unknown> {
	readonly name: string;
	readonly mode?: "cold" | "warm";
	/** Defaults to 1 -- many workload steps (population, mutation) cannot be safely repeated against the same on-disk/graph state without the caller re-seeding it. */
	readonly sampleIterations?: number;
	readonly timeoutMs?: number;
	run(): Promise<T>;
	/** Returns true when `result` is the real, expected outcome. A false result makes the step's own timing untrustworthy -- see WorkloadStepReplay.run. */
	verify(result: T): boolean;
}

export interface WorkloadStepReplay {
	readonly name: string;
	readonly passed: boolean;
	/** Present only when passed -- an untrusted timing must never be reported as if it were valid. */
	readonly run: BenchmarkRunResult | undefined;
}

export interface WorkloadReplayReport {
	readonly steps: readonly WorkloadStepReplay[];
	readonly allPassed: boolean;
}

/** Replays one workload step, verifying every sample before its timing is trusted. A real error thrown by `run()` itself propagates unchanged -- only a `verify()` rejection is captured as a failed-but-not-thrown step. */
export async function replayWorkloadStep<T>(step: WorkloadStep<T>): Promise<WorkloadStepReplay> {
	let allVerified = true;
	const run = await runBenchmarkCase<T>({
		name: step.name,
		mode: step.mode ?? "cold",
		sampleIterations: step.sampleIterations ?? 1,
		...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
		run: async () => {
			const result = await step.run();
			if (!step.verify(result)) allVerified = false;
			return result;
		},
	});
	// A step that timed out or was cancelled before completing every sample never earned real
	// verification either -- treated the same as a failed verify(), not as a trusted partial
	// result.
	const passed = allVerified && !run.timedOut && !run.cancelled && run.completedSampleIterations === run.requestedSampleIterations;
	return { name: step.name, passed, run: passed ? run : undefined };
}

/** Replays every step in order, collecting a pass/fail report -- one step's failure does not stop the others from running, since a full picture of what passed is more useful than aborting on the first red step. */
export async function replayWorkload(steps: readonly WorkloadStep[]): Promise<WorkloadReplayReport> {
	const results: WorkloadStepReplay[] = [];
	for (const step of steps) results.push(await replayWorkloadStep(step));
	return { steps: results, allPassed: results.every((result) => result.passed) };
}
