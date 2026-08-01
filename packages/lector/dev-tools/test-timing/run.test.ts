import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstrumentedTests } from "./run.ts";

function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "lector-test-timing-harness-"));
	writeFileSync(
		join(dir, "sample.test.ts"),
		'import { describe, expect, it } from "bun:test";\ndescribe("group", () => {\n\tit("passes", () => {\n\t\texpect(1).toBe(1);\n\t});\n});\n',
	);
	return dir;
}

describe("runInstrumentedTests", () => {
	it("spawns a real bun test run, mirrors its output, and returns a real timing report plus the real exit code", async () => {
		const dir = fixture();
		try {
			const stdoutChunks: string[] = [];
			const stderrChunks: string[] = [];
			const reportTexts: string[] = [];
			const { exitCode, report } = await runInstrumentedTests([dir], {
				writeStdout: (chunk) => stdoutChunks.push(chunk),
				writeStderr: (chunk) => stderrChunks.push(chunk),
				printReport: (text) => reportTexts.push(text),
			});

			expect(exitCode).toBe(0);
			expect(report.timedTestCount).toBe(1);
			expect(report.slowestTests[0]?.name).toBe("group > passes");
			// The real bun test output was genuinely mirrored, not swallowed -- a caller watching
			// stdout/stderr live still sees it, same as running bun test directly would show.
			expect(stdoutChunks.join("") + stderrChunks.join("")).toContain("group > passes");
			expect(reportTexts.join("")).toContain("group > passes");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);

	it("propagates a non-zero exit code when the underlying bun test run has a real failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lector-test-timing-harness-fail-"));
		try {
			writeFileSync(
				join(dir, "sample.test.ts"),
				'import { describe, expect, it } from "bun:test";\ndescribe("group", () => {\n\tit("fails", () => {\n\t\texpect(1).toBe(2);\n\t});\n});\n',
			);
			const { exitCode, report } = await runInstrumentedTests([dir], { writeStdout: () => {}, writeStderr: () => {}, printReport: () => {} });
			expect(exitCode).not.toBe(0);
			expect(report.slowestTests[0]?.outcome).toBe("fail");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);

	it("parses --top out of the passthrough args before handing the rest to bun test", async () => {
		const dir = fixture();
		try {
			const { report } = await runInstrumentedTests(["--top", "1", dir], { writeStdout: () => {}, writeStderr: () => {}, printReport: () => {} });
			expect(report.slowestTests).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);
});
