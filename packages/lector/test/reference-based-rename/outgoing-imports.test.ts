import { expect, it } from "bun:test";
import { findImportSpecifiers } from "../../src/code-intelligence/tree-sitter/import-specifiers.ts";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { applyReferenceBasedRename } from "../../src/reference-based-rename/apply-reference-based-rename.ts";
import { planReferenceBasedRename } from "../../src/reference-based-rename/reference-based-rename.ts";
import { InMemoryWorkspace } from "../../src/workspace/in-memory-workspace.ts";

it("cross-directory moves rewrite outgoing relative imports without changing BOM, quotes or line endings", async () => {
	const content = "\uFEFFimport { value } from './dependency.js';\r\nexport const next = value;\n";
	const plan = planReferenceBasedRename({
		fromPath: "/project/math.ts",
		toPath: "/project/nested/math.ts",
		movedFileContent: content,
		movedFileHash: contentHashOf(content),
		movedFileImportSpecifiers: await findImportSpecifiers(content, ".ts"),
		referencingFiles: [],
	});
	expect(plan.move.content).toBe("\uFEFFimport { value } from '../dependency.js';\r\nexport const next = value;\n");
	const workspace = new InMemoryWorkspace();
	await workspace.writeEntry(plan.move.fromPath, null, content);
	const applied = await applyReferenceBasedRename(workspace, plan);
	expect(applied.steps.find((step) => step.path === plan.move.fromPath)?.beforeContent).toBe(content);
});

it("file self-references follow the moved identity while package imports remain untouched", async () => {
	const content = 'export * from "./math.js";\nimport "package";\n';
	const plan = planReferenceBasedRename({
		fromPath: "/project/math.ts",
		toPath: "/project/nested/renamed.ts",
		movedFileContent: content,
		movedFileHash: contentHashOf(content),
		movedFileImportSpecifiers: await findImportSpecifiers(content, ".ts"),
		referencingFiles: [],
	});
	expect(plan.move.content).toBe('export * from "./renamed.js";\nimport "package";\n');
});
