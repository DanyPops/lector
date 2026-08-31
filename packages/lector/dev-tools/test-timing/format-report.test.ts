import { describe, expect, it } from "bun:test";
import { formatTestTimingReport } from "./format-report.ts";
import type { TestTimingReport } from "./report.ts";

function report(overrides: Partial<TestTimingReport> = {}): TestTimingReport {
	return { slowestTests: [], slowestFiles: [], files: [], layers: [], filesTruncated: false, totalDurationMs: 0, timedTestCount: 0, ...overrides };
}

describe("formatTestTimingReport", () => {
	it("lists each slow test with its file, name, and duration", () => {
		const text = formatTestTimingReport(
			report({ slowestTests: [{ file: "a.test.ts", name: "slow one", outcome: "pass", durationMs: 123.45 }], timedTestCount: 1, totalDurationMs: 123.45 }),
		);
		expect(text).toContain("a.test.ts");
		expect(text).toContain("slow one");
		expect(text).toContain("123.45ms");
	});

	it("lists each slow file with its total duration and test count", () => {
		const text = formatTestTimingReport(
			report({ slowestFiles: [{ file: "a.test.ts", layer: "component", totalMs: 500, testCount: 4 }], timedTestCount: 4, totalDurationMs: 500 }),
		);
		expect(text).toContain("a.test.ts");
		expect(text).toContain("500");
		expect(text).toContain("4");
	});

	it("reports totals by layer", () => {
		const text = formatTestTimingReport(
			report({ layers: [{ layer: "integration", totalMs: 750, testCount: 8, fileCount: 2 }], timedTestCount: 8, totalDurationMs: 750 }),
		);
		expect(text).toContain("integration");
		expect(text).toContain("750");
		expect(text).toContain("2 files");
	});

	it("reports the real overall total duration and timed test count", () => {
		const text = formatTestTimingReport(report({ totalDurationMs: 9999, timedTestCount: 42 }));
		expect(text).toContain("9999");
		expect(text).toContain("42");
	});

	it("says so plainly when there is nothing to report, rather than printing empty sections", () => {
		expect(formatTestTimingReport(report())).toContain("no timed test results found");
	});
});
