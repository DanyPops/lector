/**
 * A reusable benchmark runner: warmup, bounded repeated sampling, per-sample resource usage,
 * aggregate statistics, timeout/cancellation, and control-vs-candidate comparison with optional
 * interleaving -- the shared machinery every one-off `performance.now()` timing script in this
 * project was re-deriving by hand. Modeled on Hyperfine's warmup/repeated-run design and
 * Criterion's warmup/outlier-aware statistics, without requiring an external benchmark
 * executable.
 */
import { measureResourceUsage } from "./resource-usage.ts";
import { computeSampleStatistics, type SampleStatistics } from "./statistics.ts";

export interface BenchmarkSample {
	readonly index: number;
	readonly wallTimeMs: number;
	readonly cpuUserMs: number;
	readonly cpuSystemMs: number;
	readonly rssBytesDelta: number;
	readonly heapUsedBytesDelta: number;
	readonly externalBytesDelta: number;
	readonly resultBytes?: number;
	readonly correctnessDigest?: string;
}

export interface BenchmarkCase<T> {
	readonly name: string;
	/** Descriptive only -- "cold" (e.g. warmupIterations: 0, first-ever-call cost) vs "warm" (steady-state, matching how a long-running daemon actually behaves) is the caller's own framing, recorded for the report. */
	readonly mode: "cold" | "warm";
	/** Iterations run before measurement begins, discarded from every reported sample. Defaults to 0. */
	readonly warmupIterations?: number;
	readonly sampleIterations: number;
	/** Per-iteration timeout; an iteration exceeding it stops the whole run (timedOut: true) rather than being retried. */
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	run(iterationIndex: number): Promise<T>;
	/** Attaches a comparable size figure (e.g. serialized result bytes) to every sample. */
	resultBytes?(result: T): number;
	/** Attaches a comparable correctness fingerprint (e.g. a stable hash/join of the result) to every sample -- lets a report catch a candidate that got faster by returning fewer/wrong results. */
	correctnessDigest?(result: T): string;
}

export interface BenchmarkRunResult {
	readonly name: string;
	readonly mode: "cold" | "warm";
	readonly warmupIterations: number;
	readonly requestedSampleIterations: number;
	readonly completedSampleIterations: number;
	/** True when an iteration exceeded timeoutMs; no further iterations were attempted. */
	readonly timedOut: boolean;
	/** True when the caller's signal was aborted during (or before) sampling; no further iterations were attempted. */
	readonly cancelled: boolean;
	readonly samples: readonly BenchmarkSample[];
	/** undefined only when zero samples completed (e.g. the very first iteration timed out). */
	readonly wallTimeStatistics: SampleStatistics | undefined;
	readonly cpuUserStatistics: SampleStatistics | undefined;
	readonly cpuSystemStatistics: SampleStatistics | undefined;
}

class IterationTimedOut extends Error {
	constructor() {
		super("benchmark iteration exceeded its timeout");
		this.name = "IterationTimedOut";
	}
}

async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number | undefined): Promise<T> {
	if (timeoutMs === undefined) return fn();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			fn(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new IterationTimedOut()), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

interface CaseRunState<T> {
	readonly caseDef: BenchmarkCase<T>;
	readonly samples: BenchmarkSample[];
	timedOut: boolean;
	cancelled: boolean;
	nextIndex: number;
}

function createRunState<T>(caseDef: BenchmarkCase<T>): CaseRunState<T> {
	return { caseDef, samples: [], timedOut: false, cancelled: false, nextIndex: 0 };
}

async function runWarmup<T>(caseDef: BenchmarkCase<T>): Promise<void> {
	const warmupIterations = caseDef.warmupIterations ?? 0;
	for (let i = 0; i < warmupIterations; i++) await caseDef.run(i);
}

function caseCanContinue<T>(state: CaseRunState<T>): boolean {
	return !state.timedOut && !state.cancelled && state.samples.length < state.caseDef.sampleIterations;
}

/** Runs exactly one measured iteration, appending a sample or setting timedOut/cancelled on `state`. A real error from `run` propagates unchanged -- a broken case is a hard failure, not a discarded sample. */
async function runOneMeasuredIteration<T>(state: CaseRunState<T>): Promise<void> {
	const { caseDef } = state;
	if (caseDef.signal?.aborted) {
		state.cancelled = true;
		return;
	}
	const index = state.nextIndex;
	let measurement: Awaited<ReturnType<typeof measureResourceUsage<T>>>;
	try {
		measurement = await measureResourceUsage(() => runWithTimeout(() => caseDef.run(index), caseDef.timeoutMs));
	} catch (error) {
		if (error instanceof IterationTimedOut) {
			state.timedOut = true;
			return;
		}
		throw error;
	}
	state.nextIndex += 1;
	state.samples.push({
		index,
		wallTimeMs: measurement.wallTimeMs,
		cpuUserMs: measurement.cpuUserMs,
		cpuSystemMs: measurement.cpuSystemMs,
		rssBytesDelta: measurement.rssBytesDelta,
		heapUsedBytesDelta: measurement.heapUsedBytesDelta,
		externalBytesDelta: measurement.externalBytesDelta,
		...(caseDef.resultBytes ? { resultBytes: caseDef.resultBytes(measurement.result) } : {}),
		...(caseDef.correctnessDigest ? { correctnessDigest: caseDef.correctnessDigest(measurement.result) } : {}),
	});
	if (caseDef.signal?.aborted) state.cancelled = true;
}

function buildResult<T>(state: CaseRunState<T>): BenchmarkRunResult {
	const wallTimes = state.samples.map((sample) => sample.wallTimeMs);
	const cpuUser = state.samples.map((sample) => sample.cpuUserMs);
	const cpuSystem = state.samples.map((sample) => sample.cpuSystemMs);
	return {
		name: state.caseDef.name,
		mode: state.caseDef.mode,
		warmupIterations: state.caseDef.warmupIterations ?? 0,
		requestedSampleIterations: state.caseDef.sampleIterations,
		completedSampleIterations: state.samples.length,
		timedOut: state.timedOut,
		cancelled: state.cancelled,
		samples: state.samples,
		wallTimeStatistics: wallTimes.length > 0 ? computeSampleStatistics(wallTimes) : undefined,
		cpuUserStatistics: cpuUser.length > 0 ? computeSampleStatistics(cpuUser) : undefined,
		cpuSystemStatistics: cpuSystem.length > 0 ? computeSampleStatistics(cpuSystem) : undefined,
	};
}

/** Runs one benchmark case: warmup (discarded), then bounded repeated sampling with resource usage per sample. */
export async function runBenchmarkCase<T>(caseDef: BenchmarkCase<T>): Promise<BenchmarkRunResult> {
	await runWarmup(caseDef);
	const state = createRunState(caseDef);
	while (caseCanContinue(state)) await runOneMeasuredIteration(state);
	return buildResult(state);
}

export interface BenchmarkComparisonOptions {
	/** Alternates one control iteration then one candidate iteration per round instead of running control to completion before candidate starts -- reduces systematic drift (thermal throttling, background load ramping) from being attributed to only one side. Defaults to false. */
	readonly interleaved?: boolean;
	/** Recorded on the result for reproducibility; a caller's own `run` closure is responsible for actually consuming a seeded random source (see createSeededRandom) if its workload selection is randomized. */
	readonly seed?: number;
}

export interface BenchmarkComparison {
	readonly control: BenchmarkRunResult;
	readonly candidate: BenchmarkRunResult;
	/** control's median wall time / candidate's median wall time -- greater than 1 means candidate is faster. undefined when either side completed zero samples. */
	readonly speedupFactor: number | undefined;
	readonly interleaved: boolean;
	readonly seed: number | undefined;
}

/** Runs a control and a candidate benchmark case over the same workload shape and reports their comparison, optionally interleaved round-by-round. */
export async function runControlCandidateComparison<T>(
	control: BenchmarkCase<T>,
	candidate: BenchmarkCase<T>,
	options: BenchmarkComparisonOptions = {},
): Promise<BenchmarkComparison> {
	let controlResult: BenchmarkRunResult;
	let candidateResult: BenchmarkRunResult;

	if (options.interleaved) {
		await runWarmup(control);
		await runWarmup(candidate);
		const controlState = createRunState(control);
		const candidateState = createRunState(candidate);
		const rounds = Math.max(control.sampleIterations, candidate.sampleIterations);
		for (let round = 0; round < rounds; round++) {
			if (caseCanContinue(controlState)) await runOneMeasuredIteration(controlState);
			if (caseCanContinue(candidateState)) await runOneMeasuredIteration(candidateState);
		}
		controlResult = buildResult(controlState);
		candidateResult = buildResult(candidateState);
	} else {
		controlResult = await runBenchmarkCase(control);
		candidateResult = await runBenchmarkCase(candidate);
	}

	const controlMedian = controlResult.wallTimeStatistics?.median;
	const candidateMedian = candidateResult.wallTimeStatistics?.median;
	const speedupFactor = controlMedian !== undefined && candidateMedian !== undefined && candidateMedian > 0 ? controlMedian / candidateMedian : undefined;

	return { control: controlResult, candidate: candidateResult, speedupFactor, interleaved: options.interleaved ?? false, seed: options.seed };
}
