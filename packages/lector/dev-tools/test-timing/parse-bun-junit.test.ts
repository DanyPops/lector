import { describe, expect, it } from "bun:test";
import { parseBunJunitReport } from "./parse-bun-junit.ts";

describe("parseBunJunitReport", () => {
	it("reads authoritative file, outcome, name, and duration attributes", () => {
		const entries = parseBunJunitReport(`<?xml version="1.0"?>
<testsuites tests="3">
  <testsuite name="a.test.ts" file="a.test.ts">
    <testcase name="passes &amp; reports" classname="owner&amp;apos;s group" time="0.125" file="a.test.ts" />
    <testcase name="fails" classname="group" time="1.5" file="a.test.ts"><failure message="boom" /></testcase>
    <testcase name="skips" classname="group" time="0" file="a.test.ts"><skipped /></testcase>
  </testsuite>
</testsuites>`);

		expect(entries).toEqual([
			{ file: "a.test.ts", name: "owner's group > passes & reports", outcome: "pass", durationMs: 125 },
			{ file: "a.test.ts", name: "group > fails", outcome: "fail", durationMs: 1500 },
			{ file: "a.test.ts", name: "group > skips", outcome: "skip", durationMs: undefined },
		]);
	});

	it("rejects malformed testcase timing instead of inventing a duration", () => {
		expect(() => parseBunJunitReport('<testsuites><testcase name="bad" classname="group" time="soon" file="a.test.ts" /></testsuites>')).toThrow(
			/invalid testcase time/,
		);
	});
});
