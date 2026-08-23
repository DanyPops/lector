import { describe, expect, it } from "bun:test";
import { createSeededRandom } from "../../benchmarks/harness/seeded-random.ts";

describe("createSeededRandom", () => {
	it("produces the exact same sequence for the same seed -- deterministic reproducibility", () => {
		const a = createSeededRandom(42);
		const b = createSeededRandom(42);
		const sequenceA = Array.from({ length: 10 }, () => a());
		const sequenceB = Array.from({ length: 10 }, () => b());
		expect(sequenceA).toEqual(sequenceB);
	});

	it("produces a different sequence for a different seed", () => {
		const a = createSeededRandom(1);
		const b = createSeededRandom(2);
		const sequenceA = Array.from({ length: 10 }, () => a());
		const sequenceB = Array.from({ length: 10 }, () => b());
		expect(sequenceA).not.toEqual(sequenceB);
	});

	it("always returns a value within [0, 1)", () => {
		const rand = createSeededRandom(7);
		for (let i = 0; i < 1000; i++) {
			const value = rand();
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});
});
