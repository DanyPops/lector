/**
 * Plain-text, human-readable rendering of a BenchmarkRunResult/BenchmarkComparison -- a console
 * report for a human running a benchmark script by hand, not a machine-parsed format (that's
 * the JSON artifact from report-schema.ts).
 */
import type { BenchmarkComparison, BenchmarkRunResult } from "./benchmark-runner.ts";

function formatMs(value: number): string {
	return `${value.toFixed(2)}ms`;
}

/** Human-readable summary of one benchmark case's own run. */
export function formatBenchmarkResult(result: BenchmarkRunResult): string {
	const lines: string[] = [];
	lines.push(`${result.name} [${result.mode}] -- ${result.completedSampleIterations}/${result.requestedSampleIterations} samples (warmup: ${result.warmupIterations})`);
	if (result.timedOut) lines.push("  TIMED OUT before completing every requested sample");
	if (result.cancelled) lines.push("  CANCELLED before completing every requested sample");
	if (result.wallTimeStatistics) {
		const stats = result.wallTimeStatistics;
		lines.push(
			`  wall time: median ${formatMs(stats.median)}  p90 ${formatMs(stats.p90)}  p95 ${formatMs(stats.p95)}  p99 ${formatMs(stats.p99)}  min ${formatMs(stats.min)}  max ${formatMs(stats.max)}  stddev ${formatMs(stats.stddev)} (${stats.relativeStdDevPercent.toFixed(1)}% noise)`,
		);
	} else {
		lines.push("  no samples completed");
	}
	return lines.join("\n");
}

/** Human-readable summary of a control-vs-candidate comparison. */
export function formatBenchmarkComparison(comparison: BenchmarkComparison): string {
	const lines: string[] = [];
	lines.push(formatBenchmarkResult(comparison.control));
	lines.push(formatBenchmarkResult(comparison.candidate));
	if (comparison.speedupFactor === undefined) {
		lines.push("comparison: inconclusive -- one or both sides completed zero samples");
	} else {
		const direction = comparison.speedupFactor >= 1 ? "faster" : "slower";
		const factor = comparison.speedupFactor >= 1 ? comparison.speedupFactor : 1 / comparison.speedupFactor;
		lines.push(`comparison: candidate is ${factor.toFixed(2)}x ${direction} than control (median wall time)`);
	}
	return lines.join("\n");
}
