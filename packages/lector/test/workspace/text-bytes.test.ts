import { expect, it } from "bun:test";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { lineHashOf } from "../../src/content-identity/line-hash.ts";
import { applyPatch } from "../../src/workspace/apply-patch.ts";
import { applyWorkspaceEdit } from "../../src/workspace/apply-workspace-edit.ts";
import { InMemoryWorkspace } from "../../src/workspace/in-memory-workspace.ts";
import { lineEdit } from "../../src/workspace/line-edit.ts";

const source = "\uFEFFfirst\r\nsecond\nthird\r\n";

it("line replacement retains BOM and every unaffected mixed line ending", async () => {
	const workspace = new InMemoryWorkspace();
	await workspace.writeEntry("file", null, source);
	await lineEdit(workspace, {
		path: "file",
		edits: [
			{
				kind: "replace",
				startLine: 1,
				endLine: 1,
				expectedStartHash: lineHashOf("\uFEFFfirst\r"),
				expectedEndHash: lineHashOf("\uFEFFfirst\r"),
				lines: ["changed"],
			},
		],
	});
	expect(await workspace.readEntry("file")).toEqual({ exists: true, content: "\uFEFFchanged\r\nsecond\nthird\r\n" });
});

it("LF unified patch context matches CRLF while retaining original BOM and endings", async () => {
	const workspace = new InMemoryWorkspace();
	await workspace.writeEntry("file", null, source);
	await applyPatch(workspace, {
		path: "file",
		expectedHash: contentHashOf(source),
		patchText: "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n-first\n+changed\n second\n",
	});
	expect(await workspace.readEntry("file")).toEqual({ exists: true, content: "\uFEFFchanged\r\nsecond\nthird\r\n" });
});

it("semantic multiline replacement preserves unchanged mixed-ending context", async () => {
	const workspace = new InMemoryWorkspace();
	await workspace.writeEntry("file", null, source);
	await applyWorkspaceEdit(
		workspace,
		{
			operations: [
				{ kind: "text", path: "file", edits: [{ range: { start: { line: 1, character: 1 }, end: { line: 3, character: 1 } }, newText: "changed\nsecond\n" }] },
			],
		},
		new Map([["file", contentHashOf(source)]]),
	);
	expect(await workspace.readEntry("file")).toEqual({ exists: true, content: "\uFEFFchanged\r\nsecond\nthird\r\n" });
});

it("inserting at the start does not move or duplicate the existing BOM", async () => {
	const workspace = new InMemoryWorkspace();
	await workspace.writeEntry("file", null, source);
	await applyWorkspaceEdit(
		workspace,
		{
			operations: [
				{ kind: "text", path: "file", edits: [{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } }, newText: "header\n" }] },
			],
		},
		new Map([["file", contentHashOf(source)]]),
	);
	expect(await workspace.readEntry("file")).toEqual({ exists: true, content: "\uFEFFheader\r\nfirst\r\nsecond\nthird\r\n" });
});

it("invalid semantic positions and stale hashes refuse mutation", async () => {
	const workspace = new InMemoryWorkspace();
	await workspace.writeEntry("file", null, source);
	await expect(
		applyWorkspaceEdit(
			workspace,
			{
				operations: [
					{ kind: "text", path: "file", edits: [{ range: { start: { line: 99, character: 1 }, end: { line: 99, character: 2 } }, newText: "wrong" }] },
				],
			},
			new Map([["file", contentHashOf(source)]]),
		),
	).rejects.toThrow("outside");
	await expect(applyPatch(workspace, { path: "file", expectedHash: contentHashOf("stale"), patchText: "" })).rejects.toThrow("stale");
	expect(await workspace.readEntry("file")).toEqual({ exists: true, content: source });
});
