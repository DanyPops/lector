import { describe, expect, it } from "bun:test";
import { runBenchmarkCase, runControlCandidateComparison } from "../../benchmarks/harness/benchmark-runner.ts";

describe("runBenchmarkCase", () => {
	it("runs exactly sampleIterations measured iterations, discarding warmup iterations from the reported samples", async () => {
		let callCount = 0;
		const result = await runBenchmarkCase({
			name: "counts calls",
			mode: "warm",
			warmupIterations: 3,
			sampleIterations: 5,
			run: async () => {
				callCount++;
				return callCount;
			},
		});

		expect(callCount).toBe(8); // 3 warmup + 5 measured
		expect(result.samples).toHaveLength(5);
		expect(result.completedSampleIterations).toBe(5);
		expect(result.requestedSampleIterations).toBe(5);
		expect(result.warmupIterations).toBe(3);
		expect(result.timedOut).toBe(false);
		expect(result.cancelled).toBe(false);
	});

	it("defaults warmupIterations to 0 when omitted", async () => {
		let callCount = 0;
		const result = await runBenchmarkCase({
			name: "no warmup",
			mode: "cold",
			sampleIterations: 4,
			run: async () => {
				callCount++;
			},
		});
		expect(callCount).toBe(4);
		expect(result.warmupIterations).toBe(0);
	});

	it("records a real, positive wall time per sample and aggregate statistics matching computeSampleStatistics", async () => {
		const result = await runBenchmarkCase({
			name: "measurable work",
			mode: "warm",
			sampleIterations: 5,
			run: async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
			},
		});

		for (const sample of result.samples) expect(sample.wallTimeMs).toBeGreaterThan(0);
		expect(result.wallTimeStatistics?.count).toBe(5);
		expect(result.wallTimeStatistics?.min).toBeGreaterThan(0);
	});

	it("attaches resultBytes and correctnessDigest to each sample when the case provides them", async () => {
		const result = await runBenchmarkCase({
			name: "with correctness proof",
			mode: "warm",
			sampleIterations: 2,
			run: async () => ({ items: ["a", "b", "c"] }),
			resultBytes: (value) => JSON.stringify(value).length,
			correctnessDigest: (value) => value.items.join(","),
		});

		for (const sample of result.samples) {
			expect(sample.resultBytes).toBeGreaterThan(0);
			expect(sample.correctnessDigest).toBe("a,b,c");
		}
	});

	it("stops sampling and reports timedOut: true when an iteration exceeds timeoutMs", async () => {
		const result = await runBenchmarkCase({
			name: "hangs forever",
			mode: "warm",
			sampleIterations: 3,
			timeoutMs: 20,
			run: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10_000));
			},
		});

		expect(result.timedOut).toBe(true);
		expect(result.completedSampleIterations).toBe(0);
		expect(result.samples).toHaveLength(0);
	}, 2_000);

	it("stops sampling and reports cancelled: true when the caller's signal aborts mid-run", async () => {
		const controller = new AbortController();
		let iterations = 0;
		const result = await runBenchmarkCase({
			name: "cancellable",
			mode: "warm",
			sampleIterations: 100,
			signal: controller.signal,
			run: async () => {
				iterations++;
				if (iterations === 3) controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 5));
			},
		});

		expect(result.cancelled).toBe(true);
		expect(result.completedSampleIterations).toBeLessThan(100);
	});

	it("propagates a real error thrown by the measured function instead of silently discarding the sample", async () => {
		await expect(
			runBenchmarkCase({
				name: "throws",
				mode: "warm",
				sampleIterations: 3,
				run: async () => {
					throw new Error("real failure");
				},
			}),
		).rejects.toThrow("real failure");
	});
});

describe("runControlCandidateComparison", () => {
	it("runs both cases and reports a real speedup factor from their median wall times", async () => {
		const comparison = await runControlCandidateComparison(
			{
				name: "slow control",
				mode: "warm",
				sampleIterations: 5,
				run: async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
				},
			},
			{
				name: "fast candidate",
				mode: "warm",
				sampleIterations: 5,
				run: async () => {
					await new Promise((resolve) => setTimeout(resolve, 2));
				},
			},
		);

		expect(comparison.control.name).toBe("slow control");
		expect(comparison.candidate.name).toBe("fast candidate");
		expect(comparison.speedupFactor).toBeGreaterThan(1);
	});

	it("interleaves control/candidate iterations round-by-round when interleaved: true, instead of running one case to completion before the other starts", async () => {
		const order: string[] = [];
		await runControlCandidateComparison(
			{
				name: "control",
				mode: "warm",
				sampleIterations: 3,
				run: async () => {
					order.push("control");
				},
			},
			{
				name: "candidate",
				mode: "warm",
				sampleIterations: 3,
				run: async () => {
					order.push("candidate");
				},
			},
			{ interleaved: true },
		);

		expect(order).toEqual(["control", "candidate", "control", "candidate", "control", "candidate"]);
	});

	it("runs control fully, then candidate fully, when interleaved is omitted (default false)", async () => {
		const order: string[] = [];
		await runControlCandidateComparison(
			{
				name: "control",
				mode: "warm",
				sampleIterations: 3,
				run: async () => {
					order.push("control");
				},
			},
			{
				name: "candidate",
				mode: "warm",
				sampleIterations: 3,
				run: async () => {
					order.push("candidate");
				},
			},
		);

		expect(order).toEqual(["control", "control", "control", "candidate", "candidate", "candidate"]);
	});
});
