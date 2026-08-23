import { describe, expect, it } from "bun:test";
import type { BenchmarkComparison, BenchmarkRunResult } from "../../benchmarks/harness/benchmark-runner.ts";
import { formatBenchmarkComparison, formatBenchmarkResult } from "../../benchmarks/harness/format-report.ts";

function fakeResult(overrides: Partial<BenchmarkRunResult> = {}): BenchmarkRunResult {
	return {
		name: "fake case",
		mode: "warm",
		warmupIterations: 2,
		requestedSampleIterations: 10,
		completedSampleIterations: 10,
		timedOut: false,
		cancelled: false,
		samples: [],
		wallTimeStatistics: { count: 10, min: 1, max: 3, mean: 2, median: 2, p50: 2, p90: 2.8, p95: 2.9, p99: 2.98, stddev: 0.5, relativeStdDevPercent: 25 },
		cpuUserStatistics: undefined,
		cpuSystemStatistics: undefined,
		...overrides,
	};
}

describe("formatBenchmarkResult", () => {
	it("includes the case name, mode, sample count, and key percentiles", () => {
		const text = formatBenchmarkResult(fakeResult());
		expect(text).toContain("fake case");
		expect(text).toContain("warm");
		expect(text).toContain("10");
		expect(text).toContain("median");
	});

	it("flags a timed-out run distinctly from a completed one", () => {
		const text = formatBenchmarkResult(fakeResult({ timedOut: true, completedSampleIterations: 0, samples: [], wallTimeStatistics: undefined }));
		expect(text.toLowerCase()).toContain("timed out");
	});

	it("flags a cancelled run distinctly from a completed one", () => {
		const text = formatBenchmarkResult(fakeResult({ cancelled: true, completedSampleIterations: 3 }));
		expect(text.toLowerCase()).toContain("cancelled");
	});
});

describe("formatBenchmarkComparison", () => {
	it("reports both case names and a real speedup figure", () => {
		const baseStatistics = fakeResult().wallTimeStatistics;
		if (!baseStatistics) throw new Error("fakeResult() is expected to always provide wallTimeStatistics by default");
		const comparison: BenchmarkComparison = {
			control: fakeResult({ name: "control" }),
			candidate: fakeResult({ name: "candidate", wallTimeStatistics: { ...baseStatistics, median: 1 } }),
			speedupFactor: 2,
			interleaved: true,
			seed: 42,
		};
		const text = formatBenchmarkComparison(comparison);
		expect(text).toContain("control");
		expect(text).toContain("candidate");
		expect(text).toContain("2");
	});

	it("reports an inconclusive comparison distinctly when speedupFactor is undefined", () => {
		const comparison: BenchmarkComparison = {
			control: fakeResult({ wallTimeStatistics: undefined }),
			candidate: fakeResult(),
			speedupFactor: undefined,
			interleaved: false,
			seed: undefined,
		};
		const text = formatBenchmarkComparison(comparison);
		expect(text.toLowerCase()).toContain("inconclusive");
	});
});
