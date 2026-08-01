import type { TestTimingEntry } from "./parse-bun-test-output.ts";

const DEFAULT_TOP_SLOWEST_TESTS = 20;
const DEFAULT_TOP_SLOWEST_FILES = 20;

export interface TestTimingReportOptions {
	readonly topSlowestTests?: number;
	readonly topSlowestFiles?: number;
}

export interface FileTimingSummary {
	readonly file: string;
	readonly totalMs: number;
	readonly testCount: number;
}

export interface TestTimingReport {
	/** Slowest-first, pass/fail only -- todo/skip carry no real duration to rank by. Bounded to topSlowestTests. */
	readonly slowestTests: readonly TestTimingEntry[];
	/** Slowest-first by summed duration across every timed test in that file. Bounded to topSlowestFiles. */
	readonly slowestFiles: readonly FileTimingSummary[];
	/** The real total across every timed entry, not just the bounded top lists above -- the honest wall-clock-relevant sum. */
	readonly totalDurationMs: number;
	readonly timedTestCount: number;
}

/** Aggregates parsed bun test output into slowest-tests and slowest-files rankings, both explicitly bounded (never an unbounded dump of a suite that can have thousands of entries). */
export function buildTestTimingReport(entries: readonly TestTimingEntry[], options: TestTimingReportOptions = {}): TestTimingReport {
	const topSlowestTests = options.topSlowestTests ?? DEFAULT_TOP_SLOWEST_TESTS;
	const topSlowestFiles = options.topSlowestFiles ?? DEFAULT_TOP_SLOWEST_FILES;

	const timed = entries.filter((entry): entry is TestTimingEntry & { durationMs: number } => entry.durationMs !== undefined);

	const slowestTests = [...timed].sort((a, b) => b.durationMs - a.durationMs).slice(0, topSlowestTests);

	const totalsByFile = new Map<string, { totalMs: number; testCount: number }>();
	for (const entry of timed) {
		const running = totalsByFile.get(entry.file) ?? { totalMs: 0, testCount: 0 };
		totalsByFile.set(entry.file, { totalMs: running.totalMs + entry.durationMs, testCount: running.testCount + 1 });
	}
	const slowestFiles = [...totalsByFile.entries()]
		.map(([file, totals]) => ({ file, ...totals }))
		.sort((a, b) => b.totalMs - a.totalMs)
		.slice(0, topSlowestFiles);

	const totalDurationMs = timed.reduce((sum, entry) => sum + entry.durationMs, 0);

	return { slowestTests, slowestFiles, totalDurationMs, timedTestCount: timed.length };
}
