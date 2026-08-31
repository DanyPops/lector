import type { TestTimingEntry } from "./parse-bun-test-output.ts";
import { classifyTestLayer, type TestLayer } from "./test-layer.ts";

const DEFAULT_TOP_SLOWEST_TESTS = 20;
const DEFAULT_TOP_SLOWEST_FILES = 20;
const DEFAULT_MAX_FILES = 1_000;

export interface TestTimingReportOptions {
	readonly topSlowestTests?: number;
	readonly topSlowestFiles?: number;
	readonly maxFiles?: number;
}

export interface FileTimingSummary {
	readonly file: string;
	readonly layer: TestLayer;
	readonly totalMs: number;
	readonly testCount: number;
}

export interface LayerTimingSummary {
	readonly layer: TestLayer;
	readonly totalMs: number;
	readonly testCount: number;
	readonly fileCount: number;
}

export interface TestTimingReport {
	/** Slowest-first, pass/fail only. Bounded to topSlowestTests. */
	readonly slowestTests: readonly TestTimingEntry[];
	/** Slowest-first by summed duration. Bounded to topSlowestFiles. */
	readonly slowestFiles: readonly FileTimingSummary[];
	/** Every measured file, slowest-first, bounded to maxFiles for machine-readable reporting. */
	readonly files: readonly FileTimingSummary[];
	readonly filesTruncated: boolean;
	readonly layers: readonly LayerTimingSummary[];
	readonly totalDurationMs: number;
	readonly timedTestCount: number;
}

function positiveBound(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
	return value;
}

/** Aggregates authoritative testcase timings into bounded test/file rankings and fixed-cardinality layer totals. */
export function buildTestTimingReport(entries: readonly TestTimingEntry[], options: TestTimingReportOptions = {}): TestTimingReport {
	const topSlowestTests = positiveBound(options.topSlowestTests ?? DEFAULT_TOP_SLOWEST_TESTS, "topSlowestTests");
	const topSlowestFiles = positiveBound(options.topSlowestFiles ?? DEFAULT_TOP_SLOWEST_FILES, "topSlowestFiles");
	const maxFiles = positiveBound(options.maxFiles ?? DEFAULT_MAX_FILES, "maxFiles");
	const timed = entries.filter((entry): entry is TestTimingEntry & { durationMs: number } => entry.durationMs !== undefined);
	const slowestTests = [...timed].sort((a, b) => b.durationMs - a.durationMs).slice(0, topSlowestTests);

	const totalsByFile = new Map<string, { totalMs: number; testCount: number }>();
	for (const entry of timed) {
		const running = totalsByFile.get(entry.file) ?? { totalMs: 0, testCount: 0 };
		totalsByFile.set(entry.file, { totalMs: running.totalMs + entry.durationMs, testCount: running.testCount + 1 });
	}
	const allFiles = [...totalsByFile.entries()]
		.map(([file, totals]): FileTimingSummary => ({ file, layer: classifyTestLayer(file), ...totals }))
		.sort((a, b) => b.totalMs - a.totalMs || a.file.localeCompare(b.file));
	const files = allFiles.slice(0, maxFiles);
	const slowestFiles = allFiles.slice(0, topSlowestFiles);

	const totalsByLayer = new Map<TestLayer, { totalMs: number; testCount: number; fileCount: number }>();
	for (const file of allFiles) {
		const running = totalsByLayer.get(file.layer) ?? { totalMs: 0, testCount: 0, fileCount: 0 };
		totalsByLayer.set(file.layer, {
			totalMs: running.totalMs + file.totalMs,
			testCount: running.testCount + file.testCount,
			fileCount: running.fileCount + 1,
		});
	}
	const layers = [...totalsByLayer.entries()]
		.map(([layer, totals]): LayerTimingSummary => ({ layer, ...totals }))
		.sort((a, b) => b.totalMs - a.totalMs || a.layer.localeCompare(b.layer));
	const totalDurationMs = timed.reduce((sum, entry) => sum + entry.durationMs, 0);

	return { slowestTests, slowestFiles, files, filesTruncated: allFiles.length > files.length, layers, totalDurationMs, timedTestCount: timed.length };
}
