import { describe, expect, it } from "bun:test";
import { buildTestTimingReport } from "./report.ts";
import type { TestTimingEntry } from "./parse-bun-test-output.ts";

function entry(overrides: Partial<TestTimingEntry> = {}): TestTimingEntry {
	return { file: "a.test.ts", name: "some test", outcome: "pass", durationMs: 1, ...overrides };
}

describe("buildTestTimingReport", () => {
	it("ranks individual tests slowest-first", () => {
		const report = buildTestTimingReport([entry({ name: "slow", durationMs: 100 }), entry({ name: "fast", durationMs: 1 }), entry({ name: "mid", durationMs: 50 })]);
		expect(report.slowestTests.map((t) => t.name)).toEqual(["slow", "mid", "fast"]);
	});

	it("bounds the slowest-tests list to topSlowestTests", () => {
		const entries = Array.from({ length: 10 }, (_, i) => entry({ name: `t${i}`, durationMs: i }));
		const report = buildTestTimingReport(entries, { topSlowestTests: 3 });
		expect(report.slowestTests).toHaveLength(3);
		expect(report.slowestTests.map((t) => t.name)).toEqual(["t9", "t8", "t7"]);
	});

	it("excludes todo/skip entries from slowestTests -- they have no real duration to rank", () => {
		const report = buildTestTimingReport([entry({ name: "real", durationMs: 5 }), entry({ name: "skipped", outcome: "skip", durationMs: undefined })]);
		expect(report.slowestTests.map((t) => t.name)).toEqual(["real"]);
	});

	it("sums per-file duration across every test in that file, regardless of test order", () => {
		const report = buildTestTimingReport([
			entry({ file: "a.test.ts", durationMs: 10 }),
			entry({ file: "b.test.ts", durationMs: 100 }),
			entry({ file: "a.test.ts", durationMs: 20 }),
		]);
		const a = report.slowestFiles.find((f) => f.file === "a.test.ts");
		expect(a?.totalMs).toBe(30);
		expect(a?.testCount).toBe(2);
	});

	it("ranks files slowest-first by total duration, bounded to topSlowestFiles", () => {
		const report = buildTestTimingReport(
			[entry({ file: "slow.test.ts", durationMs: 500 }), entry({ file: "fast.test.ts", durationMs: 1 }), entry({ file: "mid.test.ts", durationMs: 50 })],
			{ topSlowestFiles: 2 },
		);
		expect(report.slowestFiles.map((f) => f.file)).toEqual(["slow.test.ts", "mid.test.ts"]);
	});

	it("reports the real total duration and timed test count across every entry, not just the bounded top lists", () => {
		const entries = Array.from({ length: 50 }, (_, i) => entry({ name: `t${i}`, durationMs: 2 }));
		const report = buildTestTimingReport(entries, { topSlowestTests: 5 });
		expect(report.totalDurationMs).toBe(100);
		expect(report.timedTestCount).toBe(50);
	});

	it("defaults topSlowestTests/topSlowestFiles to a real bound, not unbounded output", () => {
		const entries = Array.from({ length: 100 }, (_, i) => entry({ file: `f${i}.test.ts`, name: `t${i}`, durationMs: i }));
		const report = buildTestTimingReport(entries);
		expect(report.slowestTests.length).toBeLessThan(100);
		expect(report.slowestFiles.length).toBeLessThan(100);
	});
});
