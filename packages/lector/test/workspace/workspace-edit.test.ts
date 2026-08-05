import { describe, expect, it } from "bun:test";
import { parsePrepareRenameResult, parseWorkspaceEdit, UnsupportedWorkspaceEditVariant } from "../../src/workspace/workspace-edit.ts";

const RANGE_0_INDEXED = { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } };

describe("parsePrepareRenameResult", () => {
	it("parses a bare Range, converting to 1-indexed and attaching the queried path", () => {
		expect(parsePrepareRenameResult(RANGE_0_INDEXED, "/repo/a.ts")).toEqual({
			range: { path: "/repo/a.ts", start: { line: 1, character: 5 }, end: { line: 1, character: 8 } },
			placeholder: undefined,
		});
	});

	it("parses a {range, placeholder} shape", () => {
		expect(parsePrepareRenameResult({ range: RANGE_0_INDEXED, placeholder: "add" }, "/repo/a.ts")).toEqual({
			range: { path: "/repo/a.ts", start: { line: 1, character: 5 }, end: { line: 1, character: 8 } },
			placeholder: "add",
		});
	});

	it("parses a {defaultBehavior: true} shape as valid-but-unranged", () => {
		expect(parsePrepareRenameResult({ defaultBehavior: true }, "/repo/a.ts")).toEqual({ range: undefined, placeholder: undefined });
	});

	it("parses null as 'not valid here'", () => {
		expect(parsePrepareRenameResult(null, "/repo/a.ts")).toBeNull();
	});

	it("treats malformed/unrecognized shapes the same as null -- never valid by accident", () => {
		expect(parsePrepareRenameResult({ nonsense: true }, "/repo/a.ts")).toBeNull();
		expect(parsePrepareRenameResult("a string", "/repo/a.ts")).toBeNull();
		expect(parsePrepareRenameResult(42, "/repo/a.ts")).toBeNull();
	});
});

describe("parseWorkspaceEdit", () => {
	it("parses a plain `changes` map into text-edit operations, 1-indexed", () => {
		const edit = parseWorkspaceEdit({
			changes: {
				"file:///repo/a.ts": [{ range: RANGE_0_INDEXED, newText: "renamed" }],
			},
		});
		expect(edit.operations).toEqual([
			{
				kind: "text",
				path: "/repo/a.ts",
				edits: [{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 8 } }, newText: "renamed" }],
			},
		]);
	});

	it("prefers documentChanges over changes when both are present, per spec", () => {
		const edit = parseWorkspaceEdit({
			changes: { "file:///repo/wrong.ts": [{ range: RANGE_0_INDEXED, newText: "should not appear" }] },
			documentChanges: [
				{
					textDocument: { uri: "file:///repo/a.ts", version: 3 },
					edits: [{ range: RANGE_0_INDEXED, newText: "renamed" }],
				},
			],
		});
		expect(edit.operations).toEqual([
			{
				kind: "text",
				path: "/repo/a.ts",
				edits: [{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 8 } }, newText: "renamed" }],
			},
		]);
	});

	it("parses documentChanges mixing TextDocumentEdit with create/rename/delete resource operations, preserving order", () => {
		const edit = parseWorkspaceEdit({
			documentChanges: [
				{ kind: "create", uri: "file:///repo/new.ts", options: { overwrite: false, ignoreIfExists: true } },
				{ textDocument: { uri: "file:///repo/a.ts", version: 1 }, edits: [{ range: RANGE_0_INDEXED, newText: "x" }] },
				{ kind: "rename", oldUri: "file:///repo/old.ts", newUri: "file:///repo/renamed.ts", options: { overwrite: true } },
				{ kind: "delete", uri: "file:///repo/gone.ts", options: { recursive: true, ignoreIfNotExists: true } },
			],
		});
		expect(edit.operations).toEqual([
			{ kind: "create", path: "/repo/new.ts", overwrite: false, ignoreIfExists: true },
			{
				kind: "text",
				path: "/repo/a.ts",
				edits: [{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 8 } }, newText: "x" }],
			},
			{ kind: "rename", fromPath: "/repo/old.ts", toPath: "/repo/renamed.ts", overwrite: true, ignoreIfExists: false },
			{ kind: "delete", path: "/repo/gone.ts", recursive: true, ignoreIfNotExists: true },
		]);
	});

	it("defaults create/rename/delete options to their spec-defined false when omitted", () => {
		const edit = parseWorkspaceEdit({
			documentChanges: [{ kind: "create", uri: "file:///repo/new.ts" }],
		});
		expect(edit.operations).toEqual([{ kind: "create", path: "/repo/new.ts", overwrite: false, ignoreIfExists: false }]);
	});

	it("returns an empty operations list for null/empty edits, not an error", () => {
		expect(parseWorkspaceEdit(null).operations).toEqual([]);
		expect(parseWorkspaceEdit({}).operations).toEqual([]);
	});

	it("rejects a text edit carrying any field beyond range/newText/annotationId -- an unrecognized variant (e.g. a snippet edit) must fail loudly, never be silently applied as plain text", () => {
		expect(() =>
			parseWorkspaceEdit({
				changes: { "file:///repo/a.ts": [{ range: RANGE_0_INDEXED, newText: "$1renamed", insertTextFormat: 2 }] },
			}),
		).toThrow(UnsupportedWorkspaceEditVariant);
	});

	it("accepts a text edit carrying the spec-legal optional annotationId field", () => {
		const edit = parseWorkspaceEdit({
			changes: { "file:///repo/a.ts": [{ range: RANGE_0_INDEXED, newText: "renamed", annotationId: "ann1" }] },
		});
		expect(edit.operations).toHaveLength(1);
	});
});
