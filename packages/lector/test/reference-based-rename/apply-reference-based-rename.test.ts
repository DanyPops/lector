import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { applyReferenceBasedRename } from "../../src/reference-based-rename/apply-reference-based-rename.ts";
import type { ReferenceBasedRenamePlan } from "../../src/reference-based-rename/reference-based-rename.ts";
import { exactEdit, StaleExpectedHash } from "../../src/workspace/exact-edit.ts";
import { InMemoryWorkspace } from "../../src/workspace/in-memory-workspace.ts";

describe("applyReferenceBasedRename", () => {
	it("moves the file and rewrites every referencing file, atomically", async () => {
		const workspace = new InMemoryWorkspace();
		const movedContent = "export function add() {}\n";
		await exactEdit(workspace, { path: "math.ts", expectedHash: null, content: movedContent });
		const referencingContent = 'import { add } from "./math";\n';
		await exactEdit(workspace, { path: "consumer.ts", expectedHash: null, content: referencingContent });

		const plan: ReferenceBasedRenamePlan = {
			move: { fromPath: "math.ts", toPath: "arithmetic.ts", expectedHash: contentHashOf(movedContent), content: movedContent },
			importRewrites: [
				{
					path: "consumer.ts",
					expectedHash: contentHashOf(referencingContent),
					newContent: 'import { add } from "./arithmetic";\n',
					rewrittenSpecifiers: 1,
				},
			],
			caveats: ["a caveat"],
		};

		const outcome = await applyReferenceBasedRename(workspace, plan);

		expect(outcome).toEqual({
			movedTo: "arithmetic.ts",
			filesUpdated: ["consumer.ts"],
			caveats: ["a caveat"],
			steps: [
				{ path: "arithmetic.ts", beforeContent: null, afterHash: contentHashOf(movedContent) },
				{ path: "consumer.ts", beforeContent: referencingContent, afterHash: contentHashOf('import { add } from "./arithmetic";\n') },
				{ path: "math.ts", beforeContent: movedContent, afterHash: null },
			],
		});
		await expect(workspace.readEntry("math.ts")).resolves.toEqual({ exists: false });
		await expect(workspace.readEntry("arithmetic.ts")).resolves.toEqual({ exists: true, content: movedContent });
		await expect(workspace.readEntry("consumer.ts")).resolves.toEqual({ exists: true, content: 'import { add } from "./arithmetic";\n' });
	});

	it("refuses to move onto an already-existing target path, touching nothing", async () => {
		const workspace = new InMemoryWorkspace();
		const movedContent = "export const a = 1;\n";
		await exactEdit(workspace, { path: "a.ts", expectedHash: null, content: movedContent });
		await exactEdit(workspace, { path: "b.ts", expectedHash: null, content: "export const b = 2;\n" });

		const plan: ReferenceBasedRenamePlan = {
			move: { fromPath: "a.ts", toPath: "b.ts", expectedHash: contentHashOf(movedContent), content: movedContent },
			importRewrites: [],
			caveats: [],
		};

		await expect(applyReferenceBasedRename(workspace, plan)).rejects.toBeInstanceOf(StaleExpectedHash);
		await expect(workspace.readEntry("a.ts")).resolves.toEqual({ exists: true, content: movedContent });
		await expect(workspace.readEntry("b.ts")).resolves.toEqual({ exists: true, content: "export const b = 2;\n" });
	});

	it("rolls back the move and every already-rewritten referencing file when a later referencing file's hash is stale -- leaves no file touched", async () => {
		const workspace = new InMemoryWorkspace();
		const movedContent = "export function add() {}\n";
		await exactEdit(workspace, { path: "math.ts", expectedHash: null, content: movedContent });
		const firstReferencer = 'import { add } from "./math";\n// first\n';
		await exactEdit(workspace, { path: "first.ts", expectedHash: null, content: firstReferencer });
		const secondReferencerOriginal = 'import { add } from "./math";\n// second\n';
		await exactEdit(workspace, { path: "second.ts", expectedHash: null, content: secondReferencerOriginal });
		// second.ts changes underneath the plan after it was computed -- the exact race this guards against.
		await exactEdit(workspace, { path: "second.ts", expectedHash: contentHashOf(secondReferencerOriginal), content: "changed underneath the plan\n" });

		const plan: ReferenceBasedRenamePlan = {
			move: { fromPath: "math.ts", toPath: "arithmetic.ts", expectedHash: contentHashOf(movedContent), content: movedContent },
			importRewrites: [
				{
					path: "first.ts",
					expectedHash: contentHashOf(firstReferencer),
					newContent: 'import { add } from "./arithmetic";\n// first\n',
					rewrittenSpecifiers: 1,
				},
				{
					path: "second.ts",
					expectedHash: contentHashOf(secondReferencerOriginal),
					newContent: 'import { add } from "./arithmetic";\n// second\n',
					rewrittenSpecifiers: 1,
				},
			],
			caveats: [],
		};

		await expect(applyReferenceBasedRename(workspace, plan)).rejects.toBeInstanceOf(StaleExpectedHash);

		// Every file, including the successfully-rewritten first.ts and the successfully-created
		// arithmetic.ts, is rolled back -- the whole tree is exactly as it was before this call.
		await expect(workspace.readEntry("math.ts")).resolves.toEqual({ exists: true, content: movedContent });
		await expect(workspace.readEntry("arithmetic.ts")).resolves.toEqual({ exists: false });
		await expect(workspace.readEntry("first.ts")).resolves.toEqual({ exists: true, content: firstReferencer });
		await expect(workspace.readEntry("second.ts")).resolves.toEqual({ exists: true, content: "changed underneath the plan\n" });
	});

	it("rolls back cleanly when the final delete of the moved-from path fails, even though the file content is by then duplicated at both paths momentarily", async () => {
		const workspace = new InMemoryWorkspace();
		const movedContent = "export const a = 1;\n";
		await exactEdit(workspace, { path: "a.ts", expectedHash: null, content: movedContent });
		// a.ts changes underneath the plan right before delete would run.
		await exactEdit(workspace, { path: "a.ts", expectedHash: contentHashOf(movedContent), content: "changed underneath the plan\n" });

		const plan: ReferenceBasedRenamePlan = {
			move: { fromPath: "a.ts", toPath: "renamed.ts", expectedHash: contentHashOf(movedContent), content: movedContent },
			importRewrites: [],
			caveats: [],
		};

		await expect(applyReferenceBasedRename(workspace, plan)).rejects.toBeInstanceOf(StaleExpectedHash);
		await expect(workspace.readEntry("a.ts")).resolves.toEqual({ exists: true, content: "changed underneath the plan\n" });
		await expect(workspace.readEntry("renamed.ts")).resolves.toEqual({ exists: false });
	});

	it("returns an empty filesUpdated list, still moving the file, when no referencing files needed a rewrite", async () => {
		const workspace = new InMemoryWorkspace();
		const movedContent = "export const isolated = true;\n";
		await exactEdit(workspace, { path: "isolated.ts", expectedHash: null, content: movedContent });

		const plan: ReferenceBasedRenamePlan = {
			move: { fromPath: "isolated.ts", toPath: "renamed.ts", expectedHash: contentHashOf(movedContent), content: movedContent },
			importRewrites: [],
			caveats: [],
		};

		const outcome = await applyReferenceBasedRename(workspace, plan);
		expect(outcome.filesUpdated).toEqual([]);
	});
});
