#!/usr/bin/env bun
/**
 * A real test harness, not a one-off script: spawns `bun test` with whatever args/filters the
 * caller passes through, mirrors its live output exactly as a plain `bun test` invocation would
 * show it, then reports which individual tests and which files are the slowest -- the actual
 * "instrument each test run" capability, backed by a genuinely tested parser/aggregator
 * (parse-bun-test-output.ts, report.ts), not scrollback eyeballing.
 *
 * Usage: bun dev-tools/test-timing/run.ts [--top <n>] [bun test args/filters...]
 */
import { parseBunTestOutput } from "./parse-bun-test-output.ts";
import { formatTestTimingReport } from "./format-report.ts";
import { buildTestTimingReport, type TestTimingReport } from "./report.ts";

const DEFAULT_TOP = 20;

export interface TestTimingHarnessIo {
	readonly writeStdout: (chunk: string) => void;
	readonly writeStderr: (chunk: string) => void;
	readonly printReport: (text: string) => void;
}

const REAL_IO: TestTimingHarnessIo = {
	writeStdout: (chunk) => {
		process.stdout.write(chunk);
	},
	writeStderr: (chunk) => {
		process.stderr.write(chunk);
	},
	printReport: (text) => {
		console.log(text);
	},
};

/** Pulls `--top <n>` out of the argument list before the remainder is handed straight through to `bun test` as its own filters/flags. */
function extractTopFlag(args: readonly string[]): { top: number; rest: readonly string[] } {
	const index = args.indexOf("--top");
	if (index === -1) return { top: DEFAULT_TOP, rest: args };
	const value = Number(args[index + 1]);
	if (!Number.isInteger(value) || value < 1) throw new TypeError("--top requires a positive integer");
	return { top: value, rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

/** Reads a stream to completion, writing every chunk to `sink` as it arrives (so a live-attached caller sees real-time output identical to a plain `bun test` run) while also accumulating the full text for parsing once the process exits. */
async function mirrorAndCapture(stream: ReadableStream<Uint8Array>, sink: (chunk: string) => void): Promise<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		const text = decoder.decode(chunk, { stream: true });
		buffer += text;
		sink(text);
	}
	return buffer;
}

/**
 * Runs `bun test ...rest` as a real child process, mirrors its output live through `io`, and
 * returns both the process's own real exit code and a structured TestTimingReport built from
 * what it actually printed. `io` defaults to real stdout/stderr/console but is fully injectable
 * so this function -- the harness's actual logic -- is unit-testable without capturing this
 * process's own real stdout.
 */
export async function runInstrumentedTests(args: readonly string[], io: TestTimingHarnessIo = REAL_IO): Promise<{ exitCode: number; report: TestTimingReport }> {
	const { top, rest } = extractTopFlag(args);
	const child = Bun.spawn(["bun", "test", ...rest], { stdout: "pipe", stderr: "pipe" });
	const [stdoutText, stderrText, exitCode] = await Promise.all([
		mirrorAndCapture(child.stdout, io.writeStdout),
		mirrorAndCapture(child.stderr, io.writeStderr),
		child.exited,
	]);
	const entries = parseBunTestOutput(`${stdoutText}\n${stderrText}`);
	const report = buildTestTimingReport(entries, { topSlowestTests: top, topSlowestFiles: top });
	io.printReport(`\n${formatTestTimingReport(report)}`);
	return { exitCode, report };
}

if (import.meta.main) {
	const { exitCode } = await runInstrumentedTests(process.argv.slice(2));
	process.exit(exitCode);
}
