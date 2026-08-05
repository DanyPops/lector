import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { planReferenceBasedRename } from "../../src/reference-based-rename/reference-based-rename.ts";

function occurrence(content: string, specifier: string) {
	const quoted = content.indexOf(specifier);
	if (quoted === -1) throw new Error(`fixture bug: ${specifier} not found in ${content}`);
	return { specifier, startIndex: quoted, endIndex: quoted + specifier.length };
}

describe("planReferenceBasedRename", () => {
	it("rewrites an extensionless relative specifier to point at the new path", () => {
		const movedContent = "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
		const referencingContent = 'import { add } from "./math";\n\nadd(1, 2);\n';

		const plan = planReferenceBasedRename({
			fromPath: "/repo/src/math.ts",
			toPath: "/repo/src/arithmetic.ts",
			movedFileContent: movedContent,
			movedFileHash: contentHashOf(movedContent),
			referencingFiles: [
				{
					path: "/repo/src/consumer.ts",
					content: referencingContent,
					hash: contentHashOf(referencingContent),
					importSpecifiers: [occurrence(referencingContent, "./math")],
				},
			],
		});

		expect(plan.move).toEqual({
			fromPath: "/repo/src/math.ts",
			toPath: "/repo/src/arithmetic.ts",
			expectedHash: contentHashOf(movedContent),
			content: movedContent,
		});
		expect(plan.importRewrites).toEqual([
			{
				path: "/repo/src/consumer.ts",
				expectedHash: contentHashOf(referencingContent),
				newContent: 'import { add } from "./arithmetic";\n\nadd(1, 2);\n',
				rewrittenSpecifiers: 1,
			},
		]);
	});

	it("preserves an explicit extension when the original specifier had one", () => {
		const movedContent = "export const x = 1;\n";
		const referencingContent = 'import { x } from "./values.js";\n';

		const plan = planReferenceBasedRename({
			fromPath: "/repo/src/values.ts",
			toPath: "/repo/src/constants.ts",
			movedFileContent: movedContent,
			movedFileHash: contentHashOf(movedContent),
			referencingFiles: [
				{
					path: "/repo/src/user.ts",
					content: referencingContent,
					hash: contentHashOf(referencingContent),
					importSpecifiers: [occurrence(referencingContent, "./values.js")],
				},
			],
		});

		expect(plan.importRewrites[0]?.newContent).toBe('import { x } from "./constants.js";\n');
	});

	it("computes the correct relative path when the file moves into a different directory", () => {
		const movedContent = "export const y = 2;\n";
		const referencingContent = 'import { y } from "./util/values";\n';

		const plan = planReferenceBasedRename({
			fromPath: "/repo/src/util/values.ts",
			toPath: "/repo/src/shared/values.ts",
			movedFileContent: movedContent,
			movedFileHash: contentHashOf(movedContent),
			referencingFiles: [
				{
					path: "/repo/src/user.ts",
					content: referencingContent,
					hash: contentHashOf(referencingContent),
					importSpecifiers: [occurrence(referencingContent, "./util/values")],
				},
			],
		});

		expect(plan.importRewrites[0]?.newContent).toBe('import { y } from "./shared/values";\n');
	});

	it("rewrites every matching specifier occurrence in one file, and leaves unrelated specifiers untouched", () => {
		const movedContent = "export const z = 3;\n";
		const referencingContent = 'import { z } from "./values";\nexport { z as zAgain } from "./values";\nimport "./unrelated";\n';

		const plan = planReferenceBasedRename({
			fromPath: "/repo/src/values.ts",
			toPath: "/repo/src/constants.ts",
			movedFileContent: movedContent,
			movedFileHash: contentHashOf(movedContent),
			referencingFiles: [
				{
					path: "/repo/src/user.ts",
					content: referencingContent,
					hash: contentHashOf(referencingContent),
					importSpecifiers: [
						occurrence(referencingContent, "./values"),
						{
							specifier: "./values",
							startIndex: referencingContent.indexOf("./values", referencingContent.indexOf("./values") + 1),
							endIndex: referencingContent.indexOf("./values", referencingContent.indexOf("./values") + 1) + "./values".length,
						},
						occurrence(referencingContent, "./unrelated"),
					],
				},
			],
		});

		expect(plan.importRewrites[0]?.newContent).toBe('import { z } from "./constants";\nexport { z as zAgain } from "./constants";\nimport "./unrelated";\n');
		expect(plan.importRewrites[0]?.rewrittenSpecifiers).toBe(2);
	});

	it("omits a referencing file entirely from importRewrites when none of its specifiers actually resolve to the moved file", () => {
		const movedContent = "export const w = 4;\n";
		const referencingContent = 'import { other } from "./other";\n';

		const plan = planReferenceBasedRename({
			fromPath: "/repo/src/values.ts",
			toPath: "/repo/src/constants.ts",
			movedFileContent: movedContent,
			movedFileHash: contentHashOf(movedContent),
			referencingFiles: [
				{
					path: "/repo/src/user.ts",
					content: referencingContent,
					hash: contentHashOf(referencingContent),
					importSpecifiers: [occurrence(referencingContent, "./other")],
				},
			],
		});

		expect(plan.importRewrites).toEqual([]);
	});

	it("never treats a bare package specifier (no leading dot) as resolving to a local file", () => {
		const movedContent = "export const v = 5;\n";
		const referencingContent = 'import { readFile } from "node:fs";\n';

		const plan = planReferenceBasedRename({
			fromPath: "/repo/src/values.ts",
			toPath: "/repo/src/constants.ts",
			movedFileContent: movedContent,
			movedFileHash: contentHashOf(movedContent),
			referencingFiles: [
				{
					path: "/repo/src/user.ts",
					content: referencingContent,
					hash: contentHashOf(referencingContent),
					importSpecifiers: [occurrence(referencingContent, "node:fs")],
				},
			],
		});

		expect(plan.importRewrites).toEqual([]);
	});

	it("always surfaces the same explicit caveats about what this rename does not cover", () => {
		const movedContent = "export const u = 6;\n";
		const plan = planReferenceBasedRename({
			fromPath: "/repo/src/values.ts",
			toPath: "/repo/src/constants.ts",
			movedFileContent: movedContent,
			movedFileHash: contentHashOf(movedContent),
			referencingFiles: [],
		});

		expect(plan.caveats).toEqual([
			"only rewrites static import/export declarations with a literal relative specifier -- dynamic import(expr)/require(expr) with a non-literal argument, and any plain string reference, are never touched",
			"scoped to references the workspace's own populated symbol graph already knows about -- a reference in an unindexed or excluded file is not covered",
		]);
	});
});
