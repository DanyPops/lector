import { describe, expect, it } from "bun:test";
import { parseBunTestOutput } from "./parse-bun-test-output.ts";

const SINGLE_FILE_OUTPUT = `bun test v1.3.14 (0d9b296a)

sample.test.ts:
(pass) group A > passes quickly [0.04ms]
3 | describe("group A", () => {
4 | \tit("passes quickly", () => {
5 | \t\texpect(1).toBe(1);
6 | \t});
7 | \tit("fails on purpose", () => {
8 | \t\texpect(1).toBe(2);
                ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fmt-probe/sample.test.ts:8:13)
(fail) group A > fails on purpose [0.08ms]
(todo) group A > not implemented yet
(skip) group A > skipped for now

 1 pass
 1 skip
 1 todo
 1 fail
 2 expect() calls
Ran 4 tests across 1 file. [84.00ms]
`;

const MULTI_FILE_OUTPUT = `bun test v1.3.14 (0d9b296a)

sample2.test.ts:
(pass) group B > also passes [0.04ms]

sample.test.ts:
(pass) group A > passes quickly [0.02ms]
(fail) group A > fails on purpose [0.08ms]

 2 pass
 1 fail
 3 expect() calls
Ran 3 tests across 2 files. [81.00ms]
`;

describe("parseBunTestOutput", () => {
	it("extracts a passing test's file, name, and duration", () => {
		const entries = parseBunTestOutput(SINGLE_FILE_OUTPUT);
		expect(entries).toContainEqual({ file: "sample.test.ts", name: "group A > passes quickly", outcome: "pass", durationMs: 0.04 });
	});

	it("extracts a failing test's duration even though an error dump precedes its result line", () => {
		const entries = parseBunTestOutput(SINGLE_FILE_OUTPUT);
		expect(entries).toContainEqual({ file: "sample.test.ts", name: "group A > fails on purpose", outcome: "fail", durationMs: 0.08 });
	});

	it("records todo/skip entries with an undefined duration, not zero", () => {
		const entries = parseBunTestOutput(SINGLE_FILE_OUTPUT);
		expect(entries).toContainEqual({ file: "sample.test.ts", name: "group A > not implemented yet", outcome: "todo", durationMs: undefined });
		expect(entries).toContainEqual({ file: "sample.test.ts", name: "group A > skipped for now", outcome: "skip", durationMs: undefined });
	});

	it("does not mistake the error-dump code lines or the summary lines for test results", () => {
		const entries = parseBunTestOutput(SINGLE_FILE_OUTPUT);
		expect(entries).toHaveLength(4);
	});

	it("attributes each test to the file header that most recently preceded it, across multiple files", () => {
		const entries = parseBunTestOutput(MULTI_FILE_OUTPUT);
		expect(entries).toContainEqual({ file: "sample2.test.ts", name: "group B > also passes", outcome: "pass", durationMs: 0.04 });
		expect(entries).toContainEqual({ file: "sample.test.ts", name: "group A > passes quickly", outcome: "pass", durationMs: 0.02 });
		expect(entries).toContainEqual({ file: "sample.test.ts", name: "group A > fails on purpose", outcome: "fail", durationMs: 0.08 });
	});

	it("returns an empty array for output with no recognizable test result lines", () => {
		expect(parseBunTestOutput("bun test v1.3.14\n\nsomething went wrong before any test ran\n")).toEqual([]);
	});

	it("strips ANSI color codes before matching, since a real terminal-attached run colors these lines", () => {
		const colored = "sample.test.ts:\n\u001b[32m(pass)\u001b[0m group A > passes quickly [0.04ms]\n";
		expect(parseBunTestOutput(colored)).toEqual([{ file: "sample.test.ts", name: "group A > passes quickly", outcome: "pass", durationMs: 0.04 }]);
	});

	it("uses '(unknown file)' when a test result line appears with no preceding file header", () => {
		expect(parseBunTestOutput("(pass) orphaned test [1.00ms]\n")).toEqual([
			{ file: "(unknown file)", name: "orphaned test", outcome: "pass", durationMs: 1.0 },
		]);
	});
});
