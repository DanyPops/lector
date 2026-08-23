/**
 * Pure sample statistics for benchmark results -- percentile via linear interpolation between
 * closest ranks (the same method R's type-7 quantile / numpy's default "linear" interpolation
 * use), population standard deviation (the full sample IS the population being described, not a
 * survey subset), and relative dispersion (stddev/mean as a percentage -- "how noisy was this
 * run" independent of the measurement's own absolute scale).
 */

export class EmptySampleSet extends Error {
	constructor() {
		super("cannot compute statistics over zero samples");
		this.name = "EmptySampleSet";
	}
}

export class InvalidPercentile extends Error {
	constructor(readonly requested: number) {
		super(`percentile must be within [0, 100], got ${requested}`);
		this.name = "InvalidPercentile";
	}
}

/** Linear-interpolation percentile (numpy/R type-7) over `samples`, which need not be pre-sorted. */
export function percentile(samples: readonly number[], p: number): number {
	if (samples.length === 0) throw new EmptySampleSet();
	if (!Number.isFinite(p) || p < 0 || p > 100) throw new InvalidPercentile(p);
	const sorted = [...samples].sort((a, b) => a - b);
	if (sorted.length === 1) return sorted[0] as number;
	const rank = (p / 100) * (sorted.length - 1);
	const lowerIndex = Math.floor(rank);
	const upperIndex = Math.ceil(rank);
	const lower = sorted[lowerIndex] as number;
	const upper = sorted[upperIndex] as number;
	if (lowerIndex === upperIndex) return lower;
	const fraction = rank - lowerIndex;
	return lower + (upper - lower) * fraction;
}

export interface SampleStatistics {
	readonly count: number;
	readonly min: number;
	readonly max: number;
	readonly mean: number;
	readonly median: number;
	readonly p50: number;
	readonly p90: number;
	readonly p95: number;
	readonly p99: number;
	/** Population standard deviation -- the samples themselves are the full population being described, not a survey subset. */
	readonly stddev: number;
	/** stddev as a percentage of the mean -- "how noisy was this run" independent of absolute scale. 0 when the mean is 0 and stddev is also 0 (no variation to report). */
	readonly relativeStdDevPercent: number;
}

/** Summarizes one sample set (e.g. per-iteration wall-clock times) for a benchmark report. */
export function computeSampleStatistics(samples: readonly number[]): SampleStatistics {
	if (samples.length === 0) throw new EmptySampleSet();
	const sorted = [...samples].sort((a, b) => a - b);
	const count = sorted.length;
	const min = sorted[0] as number;
	const max = sorted[count - 1] as number;
	const mean = sorted.reduce((sum, value) => sum + value, 0) / count;
	const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
	const stddev = Math.sqrt(variance);
	const relativeStdDevPercent = mean === 0 ? 0 : (stddev / mean) * 100;

	return {
		count,
		min,
		max,
		mean,
		median: percentile(sorted, 50),
		p50: percentile(sorted, 50),
		p90: percentile(sorted, 90),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		stddev,
		relativeStdDevPercent,
	};
}
