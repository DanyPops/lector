import type { TestTimingReport } from "./report.ts";

/** Plain-text, human-readable rendering of a TestTimingReport -- a dev-tool console report, not a machine-parsed format. */
export function formatTestTimingReport(report: TestTimingReport): string {
	if (report.timedTestCount === 0) return "no timed test results found -- did the run actually execute any tests?";

	const lines: string[] = [];
	lines.push(`${report.timedTestCount} timed tests, ${report.totalDurationMs.toFixed(2)}ms total`);
	lines.push("");
	lines.push(`Slowest ${report.slowestTests.length} individual tests:`);
	for (const test of report.slowestTests) lines.push(`  ${test.durationMs?.toFixed(2)}ms  ${test.file} :: ${test.name}`);
	lines.push("");
	lines.push(`Slowest ${report.slowestFiles.length} files by total test duration:`);
	for (const file of report.slowestFiles) lines.push(`  ${file.totalMs.toFixed(2)}ms  (${file.testCount} tests)  ${file.file}`);
	return lines.join("\n");
}
