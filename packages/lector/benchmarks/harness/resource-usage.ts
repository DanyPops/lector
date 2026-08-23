/**
 * Wraps one measured unit of work with wall time, CPU user/system deltas, and process memory
 * deltas -- the per-sample resource shape a BenchmarkRunner records for every iteration. Errors
 * from the measured function propagate unchanged; a failing sample is the caller's concern
 * (e.g. counted as a timeout/failure), not silently absorbed here.
 */

export interface ResourceUsageMeasurement<T> {
	readonly result: T;
	readonly wallTimeMs: number;
	readonly cpuUserMs: number;
	readonly cpuSystemMs: number;
	readonly rssBytesDelta: number;
	readonly heapUsedBytesDelta: number;
	readonly externalBytesDelta: number;
}

/** Runs `fn` once, measuring real wall-clock time, CPU usage, and process memory deltas around it. */
export async function measureResourceUsage<T>(fn: () => Promise<T>): Promise<ResourceUsageMeasurement<T>> {
	const memoryBefore = process.memoryUsage();
	const cpuBefore = process.cpuUsage();
	const wallStart = process.hrtime.bigint();

	const result = await fn();

	const wallEnd = process.hrtime.bigint();
	const cpuDelta = process.cpuUsage(cpuBefore);
	const memoryAfter = process.memoryUsage();

	return {
		result,
		wallTimeMs: Number(wallEnd - wallStart) / 1_000_000,
		cpuUserMs: cpuDelta.user / 1_000,
		cpuSystemMs: cpuDelta.system / 1_000,
		rssBytesDelta: memoryAfter.rss - memoryBefore.rss,
		heapUsedBytesDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
		externalBytesDelta: memoryAfter.external - memoryBefore.external,
	};
}
