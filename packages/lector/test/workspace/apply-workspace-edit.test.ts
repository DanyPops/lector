import { describe, expect, it } from "bun:test";
import { type ContentHash, contentHashOf } from "../../src/content-identity/content-hash.ts";
import { applyWorkspaceEdit, collectTouchedPaths } from "../../src/workspace/apply-workspace-edit.ts";
import { exactEdit } from "../../src/workspace/exact-edit.ts";
import { InMemoryWorkspace } from "../../src/workspace/in-memory-workspace.ts";
import type { ParsedWorkspaceEdit } from "../../src/workspace/workspace-edit.ts";

/** Mirrors what the service layer does for real: snapshot every touched path's real current hash right before applying. */
async function snapshot(workspace: InMemoryWorkspace, edit: ParsedWorkspaceEdit): Promise<Map<string, ContentHash | null>> {
	const map = new Map<string, ContentHash | null>();
	for (const path of collectTouchedPaths(edit)) {
		const entry = await workspace.readEntry(path);
		map.set(path, entry.exists ? contentHashOf(entry.content) : null);
	}
	return map;
}

describe("applyWorkspaceEdit", () => {
	it("applies a single character-range text edit correctly, mid-line", async () => {
		const workspace = new InMemoryWorkspace();
		await exactEdit(workspace, { path: "a.ts", expectedHash: null, content: "const add = 1;\n" });
		const edit: ParsedWorkspaceEdit = {
			operations: [{ kind: "text", path: "a.ts", edits: [{ range: { start: { line: 1, character: 7 }, end: { line: 1, character: 10 } }, newText: "sum" }] }],
		};

		await applyWorkspaceEdit(workspace, edit, await snapshot(workspace, edit));

		await expect(workspace.readEntry("a.ts")).resolves.toEqual({ exists: true, content: "const sum = 1;\n" });
	});

	it("applies multiple non-overlapping text edits in the same file correctly regardless of order given", async () => {
		const workspace = new InMemoryWorkspace();
		await exactEdit(workspace, { path: "a.ts", expectedHash: null, content: "add(add(1, 2), add(3, 4));\n" });
		// Two of the three real "add" occurrences must be rewritten to "sum" -- the outer two,
		// leaving the inner "add(1, 2)" alone. Positions verified directly against the real
		// string (0-indexed occurrences at 0, 4, and 15), not assumed by hand.
		const edit: ParsedWorkspaceEdit = {
			operations: [
				{
					kind: "text",
					path: "a.ts",
					edits: [
						{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 4 } }, newText: "sum" },
						{ range: { start: { line: 1, character: 16 }, end: { line: 1, character: 19 } }, newText: "sum" },
					],
				},
			],
		};

		await applyWorkspaceEdit(workspace, edit, await snapshot(workspace, edit));

		await expect(workspace.readEntry("a.ts")).resolves.toEqual({ exists: true, content: "sum(add(1, 2), sum(3, 4));\n" });
	});

	it("applies a create + text-edit + rename + delete sequence atomically, in the given order", async () => {
		const workspace = new InMemoryWorkspace();
		await exactEdit(workspace, { path: "math.ts", expectedHash: null, content: "export function add() {}\n" });
		await exactEdit(workspace, { path: "obsolete.ts", expectedHash: null, content: "export const old = true;\n" });

		const edit: ParsedWorkspaceEdit = {
			operations: [
				{ kind: "create", path: "new-file.ts", overwrite: false, ignoreIfExists: false },
				{
					kind: "text",
					path: "math.ts",
					edits: [{ range: { start: { line: 1, character: 17 }, end: { line: 1, character: 20 } }, newText: "sum" }],
				},
				{ kind: "rename", fromPath: "math.ts", toPath: "arithmetic.ts", overwrite: false, ignoreIfExists: false },
				{ kind: "delete", path: "obsolete.ts", recursive: false, ignoreIfNotExists: false },
			],
		};

		const outcome = await applyWorkspaceEdit(workspace, edit, await snapshot(workspace, edit));

		expect([...outcome.touchedPaths].sort()).toEqual(["arithmetic.ts", "math.ts", "new-file.ts", "obsolete.ts"].sort());
		await expect(workspace.readEntry("new-file.ts")).resolves.toEqual({ exists: true, content: "" });
		await expect(workspace.readEntry("math.ts")).resolves.toEqual({ exists: false });
		await expect(workspace.readEntry("arithmetic.ts")).resolves.toEqual({ exists: true, content: "export function sum() {}\n" });
		await expect(workspace.readEntry("obsolete.ts")).resolves.toEqual({ exists: false });
	});

	it("refuses a text edit whose target changed since the caller's own snapshot, rolling back everything already applied -- leaves no file touched", async () => {
		const workspace = new InMemoryWorkspace();
		await exactEdit(workspace, { path: "a.ts", expectedHash: null, content: "const add = 1;\n" });
		const bContent = "const sub = 1;\n";
		await exactEdit(workspace, { path: "b.ts", expectedHash: null, content: bContent });

		const edit: ParsedWorkspaceEdit = {
			operations: [
				{
					kind: "text",
					path: "a.ts",
					edits: [{ range: { start: { line: 1, character: 7 }, end: { line: 1, character: 10 } }, newText: "sum" }],
				},
				{
					kind: "text",
					path: "b.ts",
					edits: [{ range: { start: { line: 1, character: 7 }, end: { line: 1, character: 10 } }, newText: "sum" }],
				},
			],
		};
		// The caller's own snapshot is taken BEFORE this external change lands -- exactly the
		// real-world gap between "the language server computed this edit" and "Lector applies
		// it" that expectedHashes exists to guard against.
		const expectedHashes = await snapshot(workspace, edit);
		await exactEdit(workspace, { path: "b.ts", expectedHash: contentHashOf(bContent), content: "changed after the snapshot was taken\n" });

		await expect(applyWorkspaceEdit(workspace, edit, expectedHashes)).rejects.toBeInstanceOf(Error);
		await expect(workspace.readEntry("a.ts")).resolves.toEqual({ exists: true, content: "const add = 1;\n" });
		await expect(workspace.readEntry("b.ts")).resolves.toEqual({ exists: true, content: "changed after the snapshot was taken\n" });
	});

	it("rejects overlapping text edits in the same file rather than applying them in an order-dependent way", async () => {
		const workspace = new InMemoryWorkspace();
		await exactEdit(workspace, { path: "a.ts", expectedHash: null, content: "const add = 1;\n" });
		const edit: ParsedWorkspaceEdit = {
			operations: [
				{
					kind: "text",
					path: "a.ts",
					edits: [
						{ range: { start: { line: 1, character: 7 }, end: { line: 1, character: 10 } }, newText: "sum" },
						{ range: { start: { line: 1, character: 8 }, end: { line: 1, character: 11 } }, newText: "xxx" },
					],
				},
			],
		};

		await expect(applyWorkspaceEdit(workspace, edit, await snapshot(workspace, edit))).rejects.toThrow(/overlap/i);
	});

	it("create with ignoreIfExists true is a no-op when the file already exists, not an error", async () => {
		const workspace = new InMemoryWorkspace();
		await exactEdit(workspace, { path: "a.ts", expectedHash: null, content: "existing\n" });
		const edit: ParsedWorkspaceEdit = { operations: [{ kind: "create", path: "a.ts", overwrite: false, ignoreIfExists: true }] };

		await applyWorkspaceEdit(workspace, edit, await snapshot(workspace, edit));

		await expect(workspace.readEntry("a.ts")).resolves.toEqual({ exists: true, content: "existing\n" });
	});

	it("delete with ignoreIfNotExists true is a no-op when the file doesn't exist, not an error", async () => {
		const workspace = new InMemoryWorkspace();
		const edit: ParsedWorkspaceEdit = { operations: [{ kind: "delete", path: "never-existed.ts", recursive: false, ignoreIfNotExists: true }] };

		await applyWorkspaceEdit(workspace, edit, await snapshot(workspace, edit));

		await expect(workspace.readEntry("never-existed.ts")).resolves.toEqual({ exists: false });
	});
});

describe("collectTouchedPaths", () => {
	it("collects every distinct path across all four operation kinds", () => {
		const edit: ParsedWorkspaceEdit = {
			operations: [
				{ kind: "create", path: "new.ts", overwrite: false, ignoreIfExists: false },
				{ kind: "text", path: "a.ts", edits: [] },
				{ kind: "rename", fromPath: "old.ts", toPath: "renamed.ts", overwrite: false, ignoreIfExists: false },
				{ kind: "delete", path: "gone.ts", recursive: false, ignoreIfNotExists: false },
				{ kind: "text", path: "a.ts", edits: [] },
			],
		};
		expect([...collectTouchedPaths(edit)].sort()).toEqual(["a.ts", "gone.ts", "new.ts", "old.ts", "renamed.ts"].sort());
	});
});
