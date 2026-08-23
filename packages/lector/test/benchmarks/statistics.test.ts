import { describe, expect, it } from "bun:test";
import { computeSampleStatistics, percentile } from "../../benchmarks/harness/statistics.ts";

describe("percentile", () => {
	it("returns the sole value for a single-sample array at any percentile", () => {
		expect(percentile([42], 50)).toBe(42);
		expect(percentile([42], 99)).toBe(42);
	});

	it("returns the exact median for an odd-length sorted array", () => {
		expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
	});

	it("interpolates between the two middle values for an even-length array", () => {
		expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
	});

	it("returns the minimum at p0 and the maximum at p100", () => {
		const samples = [5, 1, 9, 3, 7];
		expect(percentile(samples, 0)).toBe(1);
		expect(percentile(samples, 100)).toBe(9);
	});

	it("does not require the input to be pre-sorted", () => {
		expect(percentile([9, 1, 5, 3, 7], 50)).toBe(5);
	});

	it("rejects an empty sample array rather than returning a meaningless number", () => {
		expect(() => percentile([], 50)).toThrow();
	});

	it("rejects a percentile outside [0, 100]", () => {
		expect(() => percentile([1, 2, 3], -1)).toThrow();
		expect(() => percentile([1, 2, 3], 101)).toThrow();
	});
});

describe("computeSampleStatistics", () => {
	it("computes count/min/max/mean/median/p90/p95/p99 for a real sample set", () => {
		const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
		const stats = computeSampleStatistics(samples);

		expect(stats.count).toBe(100);
		expect(stats.min).toBe(1);
		expect(stats.max).toBe(100);
		expect(stats.mean).toBeCloseTo(50.5, 5);
		expect(stats.median).toBeCloseTo(50.5, 5);
		expect(stats.p50).toBeCloseTo(50.5, 5);
		expect(stats.p90).toBeCloseTo(90.1, 5);
		expect(stats.p95).toBeCloseTo(95.05, 5);
		expect(stats.p99).toBeCloseTo(99.01, 5);
	});

	it("reports zero standard deviation and zero relative dispersion for an all-identical sample set", () => {
		const stats = computeSampleStatistics([7, 7, 7, 7]);
		expect(stats.stddev).toBe(0);
		expect(stats.relativeStdDevPercent).toBe(0);
	});

	it("computes a real, nonzero standard deviation and dispersion for a varied sample set", () => {
		const stats = computeSampleStatistics([10, 20, 30, 40, 50]);
		expect(stats.stddev).toBeGreaterThan(0);
		expect(stats.relativeStdDevPercent).toBeGreaterThan(0);
		// population stddev of [10,20,30,40,50] is sqrt(200) ~= 14.142
		expect(stats.stddev).toBeCloseTo(14.142, 2);
	});

	it("rejects an empty sample array rather than returning NaN-filled statistics", () => {
		expect(() => computeSampleStatistics([])).toThrow();
	});

	it("handles a single-sample array without dividing by zero", () => {
		const stats = computeSampleStatistics([5]);
		expect(stats).toMatchObject({ count: 1, min: 5, max: 5, mean: 5, median: 5, p50: 5, p90: 5, p95: 5, p99: 5, stddev: 0, relativeStdDevPercent: 0 });
	});
});
