import { describe, expect, it } from "bun:test";
import { lineHashOf } from "../../src/content-identity/line-hash.ts";
import { exactEdit, StaleExpectedHash } from "../../src/workspace/exact-edit.ts";
import { InMemoryWorkspace } from "../../src/workspace/in-memory-workspace.ts";
import { LineEditRace, LineEditRejected, lineEdit } from "../../src/workspace/line-edit.ts";
import { rawRead } from "../../src/workspace/raw-read.ts";

async function seed(content: string): Promise<InMemoryWorkspace> {
	const workspace = new InMemoryWorkspace();
	await exactEdit(workspace, { path: "a.ts", expectedHash: null, content });
	return workspace;
}

const FIVE_LINES = "line 1\nline 2\nline 3\nline 4\nline 5";

describe("lineEdit", () => {
	it("replaces a single line guarded by its own hash", async () => {
		const workspace = await seed(FIVE_LINES);
		await lineEdit(workspace, {
			path: "a.ts",
			edits: [
				{ kind: "replace", startLine: 3, endLine: 3, expectedStartHash: lineHashOf("line 3"), expectedEndHash: lineHashOf("line 3"), lines: ["replaced"] },
			],
		});
		const read = await rawRead(workspace, "a.ts");
		expect(read.content).toBe("line 1\nline 2\nreplaced\nline 4\nline 5");
	});

	it("replaces a multi-line range guarded by its start and end hashes", async () => {
		const workspace = await seed(FIVE_LINES);
		await lineEdit(workspace, {
			path: "a.ts",
			edits: [
				{
					kind: "replace",
					startLine: 2,
					endLine: 4,
					expectedStartHash: lineHashOf("line 2"),
					expectedEndHash: lineHashOf("line 4"),
					lines: ["new a", "new b"],
				},
			],
		});
		const read = await rawRead(workspace, "a.ts");
		expect(read.content).toBe("line 1\nnew a\nnew b\nline 5");
	});

	it("deletes a line range via an empty replacement", async () => {
		const workspace = await seed(FIVE_LINES);
		await lineEdit(workspace, {
			path: "a.ts",
			edits: [{ kind: "replace", startLine: 2, endLine: 3, expectedStartHash: lineHashOf("line 2"), expectedEndHash: lineHashOf("line 3"), lines: [] }],
		});
		const read = await rawRead(workspace, "a.ts");
		expect(read.content).toBe("line 1\nline 4\nline 5");
	});

	it("inserts before an anchor line", async () => {
		const workspace = await seed(FIVE_LINES);
		await lineEdit(workspace, { path: "a.ts", edits: [{ kind: "insertBefore", atLine: 1, expectedHash: lineHashOf("line 1"), lines: ["prefix"] }] });
		const read = await rawRead(workspace, "a.ts");
		expect(read.content).toBe("prefix\nline 1\nline 2\nline 3\nline 4\nline 5");
	});

	it("inserts after an anchor line, including the last line", async () => {
		const workspace = await seed(FIVE_LINES);
		await lineEdit(workspace, { path: "a.ts", edits: [{ kind: "insertAfter", atLine: 5, expectedHash: lineHashOf("line 5"), lines: ["suffix"] }] });
		const read = await rawRead(workspace, "a.ts");
		expect(read.content).toBe("line 1\nline 2\nline 3\nline 4\nline 5\nsuffix");
	});

	it("applies several non-overlapping edits atomically in one call, each guarded independently", async () => {
		const workspace = await seed(FIVE_LINES);
		await lineEdit(workspace, {
			path: "a.ts",
			edits: [
				{ kind: "replace", startLine: 1, endLine: 1, expectedStartHash: lineHashOf("line 1"), expectedEndHash: lineHashOf("line 1"), lines: ["one"] },
				{ kind: "replace", startLine: 5, endLine: 5, expectedStartHash: lineHashOf("line 5"), expectedEndHash: lineHashOf("line 5"), lines: ["five"] },
				{ kind: "insertAfter", atLine: 3, expectedHash: lineHashOf("line 3"), lines: ["inserted"] },
			],
		});
		const read = await rawRead(workspace, "a.ts");
		expect(read.content).toBe("one\nline 2\nline 3\ninserted\nline 4\nfive");
	});

	it("THE CORE VALUE PROPOSITION: an edit succeeds even though a different, unrelated line changed after the caller's own last read -- a whole-file hash guard would have rejected this outright", async () => {
		const workspace = await seed(FIVE_LINES);
		// Simulate a concurrent, unrelated edit to line 1 that the caller preparing this
		// lineEdit call never saw and never needs to know about.
		await lineEdit(workspace, {
			path: "a.ts",
			edits: [
				{
					kind: "replace",
					startLine: 1,
					endLine: 1,
					expectedStartHash: lineHashOf("line 1"),
					expectedEndHash: lineHashOf("line 1"),
					lines: ["changed by someone else"],
				},
			],
		});

		// The caller's own edit, computed against the ORIGINAL content, targets line 4 --
		// a line untouched by the concurrent edit above. It must still succeed.
		await lineEdit(workspace, {
			path: "a.ts",
			edits: [
				{ kind: "replace", startLine: 4, endLine: 4, expectedStartHash: lineHashOf("line 4"), expectedEndHash: lineHashOf("line 4"), lines: ["my own edit"] },
			],
		});

		const read = await rawRead(workspace, "a.ts");
		expect(read.content).toBe("changed by someone else\nline 2\nline 3\nmy own edit\nline 5");
	});

	it("rejects the whole batch, with a structured per-edit reason, when a referenced line actually changed", async () => {
		const workspace = await seed(FIVE_LINES);
		await lineEdit(workspace, {
			path: "a.ts",
			edits: [
				{ kind: "replace", startLine: 2, endLine: 2, expectedStartHash: lineHashOf("line 2"), expectedEndHash: lineHashOf("line 2"), lines: ["changed"] },
			],
		});

		const attempt = lineEdit(workspace, {
			path: "a.ts",
			// Still references line 2's OLD hash -- now stale.
			edits: [
				{ kind: "replace", startLine: 2, endLine: 2, expectedStartHash: lineHashOf("line 2"), expectedEndHash: lineHashOf("line 2"), lines: ["my stale edit"] },
			],
		});

		await expect(attempt).rejects.toBeInstanceOf(LineEditRejected);
		try {
			await attempt;
		} catch (error) {
			const rejected = error as LineEditRejected;
			expect(rejected.failures).toHaveLength(1);
			expect(rejected.failures[0]).toMatchObject({ editIndex: 0, reason: "hash-mismatch", actualHash: lineHashOf("changed") });
		}

		// Nothing further was written -- the second, rejected attempt is all-or-nothing.
		const read = await rawRead(workspace, "a.ts");
		expect(read.content).toBe("line 1\nchanged\nline 3\nline 4\nline 5");
	});

	it("reports every failing edit in one round trip, not just the first", async () => {
		const workspace = await seed(FIVE_LINES);
		const attempt = lineEdit(workspace, {
			path: "a.ts",
			edits: [
				{ kind: "replace", startLine: 1, endLine: 1, expectedStartHash: lineHashOf("wrong"), expectedEndHash: lineHashOf("wrong"), lines: ["x"] },
				{ kind: "insertAfter", atLine: 99, expectedHash: lineHashOf("anything"), lines: ["y"] },
			],
		});
		await expect(attempt).rejects.toBeInstanceOf(LineEditRejected);
		try {
			await attempt;
		} catch (error) {
			const rejected = error as LineEditRejected;
			expect(rejected.failures.map((f) => f.reason)).toEqual(["hash-mismatch", "out-of-bounds"]);
		}
	});

	it("rejects overlapping edits rather than applying them in an order-dependent way", async () => {
		const workspace = await seed(FIVE_LINES);
		const attempt = lineEdit(workspace, {
			path: "a.ts",
			edits: [
				{ kind: "replace", startLine: 2, endLine: 3, expectedStartHash: lineHashOf("line 2"), expectedEndHash: lineHashOf("line 3"), lines: ["a"] },
				{ kind: "replace", startLine: 3, endLine: 4, expectedStartHash: lineHashOf("line 3"), expectedEndHash: lineHashOf("line 4"), lines: ["b"] },
			],
		});
		await expect(attempt).rejects.toBeInstanceOf(LineEditRejected);
		try {
			await attempt;
		} catch (error) {
			expect((error as LineEditRejected).failures[0]?.reason).toBe("overlapping-edits");
		}
	});

	it("rejects an edit line containing an embedded newline", async () => {
		const workspace = await seed(FIVE_LINES);
		const attempt = lineEdit(workspace, {
			path: "a.ts",
			edits: [
				{ kind: "replace", startLine: 1, endLine: 1, expectedStartHash: lineHashOf("line 1"), expectedEndHash: lineHashOf("line 1"), lines: ["two\nlines"] },
			],
		});
		await expect(attempt).rejects.toBeInstanceOf(LineEditRejected);
		try {
			await attempt;
		} catch (error) {
			expect((error as LineEditRejected).failures[0]?.reason).toBe("embedded-newline");
		}
	});

	it("surfaces a genuine write-time race (not a semantic hash-mismatch) as LineEditRace", async () => {
		// A workspace whose writeEntry always reports the write raced, regardless of the
		// expectedHash given -- simulates a concurrent writer landing between lineEdit's own
		// read and write, a real but narrow window distinct from a referenced-line mismatch.
		const workspace = new InMemoryWorkspace();
		await exactEdit(workspace, { path: "a.ts", expectedHash: null, content: FIVE_LINES });
		const racy = {
			resolvePath: (path: string) => workspace.resolvePath(path),
			readEntry: (path: string) => workspace.readEntry(path),
			writeEntry: async () => {
				throw new StaleExpectedHash("a.ts", null, null);
			},
			deleteEntry: async () => {
				throw new StaleExpectedHash("a.ts", null, null);
			},
		};

		const attempt = lineEdit(racy, {
			path: "a.ts",
			edits: [{ kind: "replace", startLine: 1, endLine: 1, expectedStartHash: lineHashOf("line 1"), expectedEndHash: lineHashOf("line 1"), lines: ["x"] }],
		});
		await expect(attempt).rejects.toBeInstanceOf(LineEditRace);
	});
});
