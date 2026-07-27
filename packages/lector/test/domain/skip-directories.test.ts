import { describe, expect, it } from "bun:test";
import { pathHasSkippedDirectorySegment } from "../../src/domain/skip-directories.ts";

describe("pathHasSkippedDirectorySegment", () => {
	it("flags a path with a node_modules segment, absolute or relative, either separator", () => {
		expect(pathHasSkippedDirectorySegment("/home/user/project/node_modules/typescript/lib/lib.es5.d.ts")).toBe(true);
		expect(pathHasSkippedDirectorySegment("node_modules/foo/index.ts")).toBe(true);
		expect(pathHasSkippedDirectorySegment(String.raw`C:\project\node_modules\foo\index.ts`)).toBe(true);
	});

	it("flags .git, dist, build, out, and coverage the same way", () => {
		for (const skipped of [".git", "dist", "build", "out", "coverage"]) {
			expect(pathHasSkippedDirectorySegment(`/repo/${skipped}/generated.ts`)).toBe(true);
		}
	});

	it("does not flag a real source path with no skipped segment", () => {
		expect(pathHasSkippedDirectorySegment("/home/user/project/src/domain/workspace-map.ts")).toBe(false);
	});

	it("does not flag a name that merely contains a skipped word as a substring, not a whole segment", () => {
		expect(pathHasSkippedDirectorySegment("/home/user/my-node_modules-fixture/src/index.ts")).toBe(false);
	});
});
