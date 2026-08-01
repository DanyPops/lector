/**
 * Parses `bun test`'s own textual output into structured per-test timing entries -- no
 * dependency on Bun's own (currently absent) machine-readable timing report, so this must
 * stay honest about the exact text format bun test v1.3.14 actually emits, confirmed directly
 * against a real run rather than assumed: file headers on their own line ending in `:`
 * immediately followed by that file's own `(pass)`/`(fail)/(todo)/(skip)` lines, with pass/fail
 * carrying a real `[N.NNms]` duration and todo/skip carrying none. Bun writes all of this to
 * stderr, not stdout -- callers must capture both streams and concatenate before parsing.
 */

export type TestOutcome = "pass" | "fail" | "todo" | "skip";

export interface TestTimingEntry {
	readonly file: string;
	readonly name: string;
	readonly outcome: TestOutcome;
	/** Undefined for todo/skip -- neither ever ran, so there is no real duration to report, not zero. */
	readonly durationMs: number | undefined;
}

const UNKNOWN_FILE = "(unknown file)";

// Anchored start-to-end: a real bun test file header is exactly "<path>:" with nothing else on
// the line, distinguishing it from an error-dump line that merely happens to mention a path.
const FILE_HEADER = /^(\S+\.(?:test|spec)\.(?:[cm]?[jt]sx?)):$/;
const TIMED_RESULT = /^\((pass|fail)\)\s+(.+?)\s+\[([\d.]+)ms\]$/;
const UNTIMED_RESULT = /^\((todo|skip)\)\s+(.+)$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching real ANSI escape sequences to strip them.
const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function parseBunTestOutput(rawOutput: string): readonly TestTimingEntry[] {
	const entries: TestTimingEntry[] = [];
	let currentFile: string | undefined;

	for (const rawLine of rawOutput.split("\n")) {
		const line = rawLine.replace(ANSI_ESCAPE, "").trim();
		if (line.length === 0) continue;

		const fileHeader = FILE_HEADER.exec(line);
		if (fileHeader) {
			currentFile = fileHeader[1];
			continue;
		}

		const timed = TIMED_RESULT.exec(line);
		if (timed) {
			const [, outcome, name, duration] = timed as unknown as [string, TestOutcome, string, string];
			entries.push({ file: currentFile ?? UNKNOWN_FILE, name, outcome, durationMs: Number(duration) });
			continue;
		}

		const untimed = UNTIMED_RESULT.exec(line);
		if (untimed) {
			const [, outcome, name] = untimed as unknown as [string, TestOutcome, string];
			entries.push({ file: currentFile ?? UNKNOWN_FILE, name, outcome, durationMs: undefined });
		}
		// Every other line (the version banner, error-dump source excerpts and stack frames, the
		// trailing summary counts) is neither a file header nor a test result -- ignored.
	}

	return entries;
}
