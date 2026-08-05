import { describe, expect, it } from "bun:test";
import { InvalidUnifiedDiff, parseUnifiedDiff } from "../../src/workspace/unified-diff.ts";

describe("parseUnifiedDiff", () => {
	it("parses a single hunk with context, removal, and addition lines", () => {
		const patch = "@@ -1,3 +1,3 @@\n context\n-old\n+new\n context\n";
		const hunks = parseUnifiedDiff(patch);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]).toEqual({ oldStart: 1, beforeLines: ["context", "old", "context"], afterLines: ["context", "new", "context"] });
	});

	it("skips --- / +++ file-header lines when present", () => {
		const patch = "--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
		const hunks = parseUnifiedDiff(patch);
		expect(hunks).toEqual([{ oldStart: 1, beforeLines: ["old"], afterLines: ["new"] }]);
	});

	it("parses multiple hunks", () => {
		const patch = "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -5,1 +5,1 @@\n-c\n+d\n";
		const hunks = parseUnifiedDiff(patch);
		expect(hunks).toHaveLength(2);
		expect(hunks[0]?.oldStart).toBe(1);
		expect(hunks[1]?.oldStart).toBe(5);
	});

	it("accepts a hunk header with no explicit count (defaults implied, not required by the parser)", () => {
		const patch = "@@ -5 +5 @@\n-x\n+y\n";
		expect(parseUnifiedDiff(patch)).toEqual([{ oldStart: 5, beforeLines: ["x"], afterLines: ["y"] }]);
	});

	it("rejects text with no real @@ hunks", () => {
		expect(() => parseUnifiedDiff("just some text\nno hunks here\n")).toThrow(InvalidUnifiedDiff);
	});

	it("ignores stray preamble text before the first hunk", () => {
		const patch = "commit message or other preamble\n@@ -1,1 +1,1 @@\n-a\n+b\n";
		expect(parseUnifiedDiff(patch)).toEqual([{ oldStart: 1, beforeLines: ["a"], afterLines: ["b"] }]);
	});
});
