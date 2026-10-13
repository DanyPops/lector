import { expect, it } from "bun:test";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { InMemoryWorkspace } from "../../src/workspace/in-memory-workspace.ts";
import { applyMutationPlan, MutationRollbackIncomplete, previewMutationPlan } from "../../src/workspace/mutation-plan.ts";
import type { WorkspacePort } from "../../src/workspace/port.ts";

async function fixture() {
	const workspace = new InMemoryWorkspace();
	await workspace.writeEntry("a", null, "one\n");
	await workspace.writeEntry("b", null, "one\n");
	const edit = {
		operations: ["a", "b"].map((path) => ({
			kind: "text" as const,
			path,
			edits: [{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 4 } }, newText: "two" }],
		})),
	};
	const plan = await previewMutationPlan(workspace, edit, { maxFiles: 2, maxEdits: 2, maxBytes: 10000 });
	return { workspace, edit, plan };
}

it("unchanged paths in the approved operation remain hash-guarded", async () => {
	const { workspace, edit } = await fixture();
	const operations = [...edit.operations, { kind: "create" as const, path: "existing", overwrite: false, ignoreIfExists: true }];
	await workspace.writeEntry("existing", null, "original");
	const plan = await previewMutationPlan(workspace, { operations }, { maxFiles: 3, maxEdits: 3, maxBytes: 10000 });
	expect(plan.files.some((file) => file.path === "existing")).toBe(false);
	await workspace.writeEntry("existing", contentHashOf("original"), "changed");
	await expect(applyMutationPlan(workspace, plan)).rejects.toThrow("stale");
	expect(await workspace.readEntry("a")).toEqual({ exists: true, content: "one\n" });
});

it("formatter failure and plan bounds refuse before any real write", async () => {
	const { workspace, edit } = await fixture();
	await expect(
		previewMutationPlan(workspace, edit, { maxFiles: 2, maxEdits: 2, maxBytes: 10000 }, async () => {
			throw new Error("formatter failed");
		}),
	).rejects.toThrow("formatter failed");
	await expect(previewMutationPlan(workspace, edit, { maxFiles: 1, maxEdits: 2, maxBytes: 10000 })).rejects.toThrow("bounds");
	expect(await workspace.readEntry("a")).toEqual({ exists: true, content: "one\n" });
});

for (const incomplete of [false, true]) {
	it(`failed writes report ${incomplete ? "incomplete rollback" : "successful rollback"} without clobbering unrelated data`, async () => {
		const { workspace, plan } = await fixture();
		const fault: WorkspacePort = {
			resolvePath: (path) => workspace.resolvePath(path),
			readEntry: (path) => workspace.readEntry(path),
			deleteEntry: (path, hash) => workspace.deleteEntry(path, hash),
			writeEntry: async (path, hash, content) => {
				if (path === "b" || (incomplete && path === "a" && content === "one\n")) throw new Error("storage failure");
				return workspace.writeEntry(path, hash, content);
			},
		};
		if (incomplete) await expect(applyMutationPlan(fault, plan)).rejects.toBeInstanceOf(MutationRollbackIncomplete);
		else await expect(applyMutationPlan(fault, plan)).rejects.toThrow("storage failure");
		expect(await workspace.readEntry("a")).toEqual({ exists: true, content: incomplete ? "two\n" : "one\n" });
		expect(await workspace.readEntry("b")).toEqual({ exists: true, content: "one\n" });
	});
}
