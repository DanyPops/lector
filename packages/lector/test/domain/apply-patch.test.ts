import { describe, expect, it } from "bun:test";
import { InMemoryWorkspace } from "../../src/adapters/in-memory-workspace.ts";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { applyPatch, PatchRejected } from "../../src/domain/apply-patch.ts";
import { exactEdit, StaleExpectedHash } from "../../src/domain/exact-edit.ts";

async function seed(content: string): Promise<InMemoryWorkspace> {
	const workspace = new InMemoryWorkspace();
	await exactEdit(workspace, { path: "a.ts", expectedHash: null, content });
	return workspace;
}

describe("applyPatch", () => {
	it("applies a single hunk's addition/removal against real content", async () => {
		const content = "line 1\nline 2\nline 3";
		const workspace = await seed(content);
		const patch = "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line 2 changed\n line 3\n";

		await applyPatch(workspace, { path: "a.ts", expectedHash: contentHashOf(content), patchText: patch });

		const read = await workspace.readEntry("a.ts");
		expect(read.exists && read.content).toBe("line 1\nline 2 changed\nline 3");
	});

	it("applies multiple hunks in order, tracking the cumulative line-count offset correctly", async () => {
		const content = "a\nb\nc\nd\ne";
		const workspace = await seed(content);
		// Hunk 1 grows the file by one line (adds "b2"); hunk 2 targets original line 5 ("e"),
		// which is now at a different position -- offset tracking must account for that.
		const patch = "@@ -2,1 +2,2 @@\n-b\n+b\n+b2\n@@ -5,1 +6,1 @@\n-e\n+e changed\n";

		await applyPatch(workspace, { path: "a.ts", expectedHash: contentHashOf(content), patchText: patch });

		const read = await workspace.readEntry("a.ts");
		expect(read.exists && read.content).toBe("a\nb\nb2\nc\nd\ne changed");
	});

	it("THE CORE VALUE PROPOSITION: applies correctly even though the file shifted since the patch was generated -- a pure line-offset apply would target the wrong lines", async () => {
		// The patch below was "generated" against a version of the file where "target" was at
		// line 2. By the time it's applied, three unrelated lines were inserted above it, so
		// "target" is really at line 5 now -- the hunk header's own line number (2) is stale.
		const shiftedContent = "inserted 1\ninserted 2\ninserted 3\nkeep\ntarget\nkeep after";
		const workspace = await seed(shiftedContent);
		const patch = "@@ -1,3 +1,3 @@\n keep\n-target\n+target changed\n keep after\n";

		await applyPatch(workspace, { path: "a.ts", expectedHash: contentHashOf(shiftedContent), patchText: patch });

		const read = await workspace.readEntry("a.ts");
		expect(read.exists && read.content).toBe("inserted 1\ninserted 2\ninserted 3\nkeep\ntarget changed\nkeep after");
	});

	it("disambiguates identical context appearing more than once by preferring the occurrence nearest the hunk's own hint", async () => {
		const content = "same\nsame\nsame";
		const workspace = await seed(content);
		// Header claims line 2 -- the middle occurrence should be the one replaced, not the first.
		const patch = "@@ -2,1 +2,1 @@\n-same\n+middle one\n";

		await applyPatch(workspace, { path: "a.ts", expectedHash: contentHashOf(content), patchText: patch });

		const read = await workspace.readEntry("a.ts");
		expect(read.exists && read.content).toBe("same\nmiddle one\nsame");
	});

	it("inserts at the hinted position for a pure-addition hunk with no context to disambiguate against", async () => {
		const content = "line 1\nline 2";
		const workspace = await seed(content);
		const patch = "@@ -1,0 +1,1 @@\n+inserted\n";

		await applyPatch(workspace, { path: "a.ts", expectedHash: contentHashOf(content), patchText: patch });

		const read = await workspace.readEntry("a.ts");
		expect(read.exists && read.content).toBe("inserted\nline 1\nline 2");
	});

	it("rejects with PatchRejected when a hunk's context can no longer be found anywhere", async () => {
		const content = "line 1\nline 2\nline 3";
		const workspace = await seed(content);
		const patch = "@@ -1,1 +1,1 @@\n-this text was never in the file\n+replacement\n";

		const attempt = applyPatch(workspace, { path: "a.ts", expectedHash: contentHashOf(content), patchText: patch });
		await expect(attempt).rejects.toBeInstanceOf(PatchRejected);

		const read = await workspace.readEntry("a.ts");
		expect(read.exists && read.content).toBe(content);
	});

	it("rejects a stale whole-file hash before ever parsing or applying hunks", async () => {
		const content = "line 1\nline 2";
		const workspace = await seed(content);
		const patch = "@@ -1,1 +1,1 @@\n-line 1\n+changed\n";

		const attempt = applyPatch(workspace, { path: "a.ts", expectedHash: contentHashOf("completely different content"), patchText: patch });
		await expect(attempt).rejects.toBeInstanceOf(StaleExpectedHash);

		const read = await workspace.readEntry("a.ts");
		expect(read.exists && read.content).toBe(content);
	});

	it("aborts the whole patch, writing nothing, when a later hunk fails after an earlier one would have succeeded", async () => {
		const content = "a\nb\nc";
		const workspace = await seed(content);
		const patch = "@@ -1,1 +1,1 @@\n-a\n+a changed\n@@ -99,1 +99,1 @@\n-nonexistent\n+x\n";

		const attempt = applyPatch(workspace, { path: "a.ts", expectedHash: contentHashOf(content), patchText: patch });
		await expect(attempt).rejects.toBeInstanceOf(PatchRejected);

		const read = await workspace.readEntry("a.ts");
		expect(read.exists && read.content).toBe(content);
	});
});
