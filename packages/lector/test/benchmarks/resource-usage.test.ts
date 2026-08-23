import { describe, expect, it } from "bun:test";
import { measureResourceUsage } from "../../benchmarks/harness/resource-usage.ts";

describe("measureResourceUsage", () => {
	it("returns the wrapped function's own result unchanged", async () => {
		const { result } = await measureResourceUsage(async () => ({ payload: "real result" }));
		expect(result).toEqual({ payload: "real result" });
	});

	it("measures a real, positive wall-clock time for work that actually takes measurable time", async () => {
		const { wallTimeMs } = await measureResourceUsage(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return undefined;
		});
		expect(wallTimeMs).toBeGreaterThanOrEqual(15);
	});

	it("measures non-negative CPU user/system deltas for real CPU-bound work", async () => {
		const { cpuUserMs, cpuSystemMs } = await measureResourceUsage(async () => {
			let total = 0;
			for (let i = 0; i < 5_000_000; i++) total += i;
			return total;
		});
		expect(cpuUserMs).toBeGreaterThanOrEqual(0);
		expect(cpuSystemMs).toBeGreaterThanOrEqual(0);
	});

	it("measures a heapUsedBytesDelta as a real finite number, positive or negative", async () => {
		const { heapUsedBytesDelta } = await measureResourceUsage(async () => {
			const big = new Array(100_000).fill("x");
			return big.length;
		});
		expect(Number.isFinite(heapUsedBytesDelta)).toBe(true);
	});

	it("propagates a real rejection from the measured function instead of swallowing it", async () => {
		await expect(
			measureResourceUsage(async () => {
				throw new Error("real failure inside the measured work");
			}),
		).rejects.toThrow("real failure inside the measured work");
	});
});
