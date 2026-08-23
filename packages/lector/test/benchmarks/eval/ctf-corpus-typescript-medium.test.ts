/**
 * Fixture self-test discipline, applied to the tier-2 medium corpus: hand-apply a real, correct,
 * COMPREHENSIVE rename/move across all real call sites in the vendored axios/lib snapshot, and
 * confirm the checker recognizes it; hand-apply a real, plausible partial mistake (a missed call
 * site among the ~19 real ones) and confirm the checker actually catches it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CTF_CORPUS_TYPESCRIPT_MEDIUM } from "../../../benchmarks/eval/ctf-corpus-typescript-medium.ts";
import { materializeTypescriptMediumAxiosFixture, type TypescriptMediumAxiosFixture } from "../../support/typescript-medium-axios-fixture.ts";

let fixture: TypescriptMediumAxiosFixture | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

async function walkJsFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkJsFiles(full)));
		else if (entry.name.endsWith(".js")) files.push(full);
	}
	return files;
}

describe("CTF_CORPUS_TYPESCRIPT_MEDIUM", () => {
	it("has no duplicate task ids", () => {
		const ids = CTF_CORPUS_TYPESCRIPT_MEDIUM.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("vendors a real, moderately-sized (~69 file) JS snapshot, not a small hand-crafted fixture", () => {
		fixture = materializeTypescriptMediumAxiosFixture();
		const manifest: unknown = JSON.parse(require("node:fs").readFileSync(join(fixture.root, "fixture.json"), "utf-8"));
		expect((manifest as { fileCount: number }).fileCount).toBeGreaterThanOrEqual(50);
	});

	it("rename-forEach-to-iterateEach-across-lib: scores a real, comprehensive rename across every real call site as a full pass", async () => {
		fixture = materializeTypescriptMediumAxiosFixture();
		const files = await walkJsFiles(join(fixture.root, "lib"));
		let realCallSitesRenamed = 0;
		for (const file of files) {
			const content = await readFile(file, "utf-8");
			if (!content.includes("utils.forEach(") && !content.includes("forEach(")) continue;
			let updated = content.replaceAll("utils.forEach(", "utils.iterateEach(");
			if (file.endsWith("utils.js")) {
				updated = updated
					.replace("function forEach(obj, fn,", "function iterateEach(obj, fn,")
					.replace("  forEach(source, assignValue);", "  iterateEach(source, assignValue);")
					.replace("  forEach(", "  iterateEach(")
					.replace("  forEach,\n", "  iterateEach,\n");
			}
			if (updated !== content) {
				await writeFile(file, updated);
				realCallSitesRenamed++;
			}
		}
		expect(realCallSitesRenamed).toBeGreaterThan(5); // sanity: this really touched many real files

		const task = CTF_CORPUS_TYPESCRIPT_MEDIUM.find((entry) => entry.id === "rename-forEach-to-iterateEach-across-lib");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(true);
	}, 30_000);

	it("rename-forEach-to-iterateEach-across-lib: scores a real partial rename (one missed real call site) as a failure", async () => {
		fixture = materializeTypescriptMediumAxiosFixture();
		const utilsPath = join(fixture.root, "lib/utils.js");
		const utils = await readFile(utilsPath, "utf-8");
		await writeFile(utilsPath, utils.replace("function forEach(obj, fn,", "function iterateEach(obj, fn,").replace("  forEach,\n", "  iterateEach,\n"));
		// Deliberately leaves every external `utils.forEach(...)` call site (e.g. lib/core/Axios.js)
		// untouched -- the real, plausible mistake this tier's own broad checker must catch.

		const task = CTF_CORPUS_TYPESCRIPT_MEDIUM.find((entry) => entry.id === "rename-forEach-to-iterateEach-across-lib");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 30_000);

	it("move-isSpecCompliantForm-to-new-file: scores a real correct move as a full pass", async () => {
		fixture = materializeTypescriptMediumAxiosFixture();
		const utilsPath = join(fixture.root, "lib/utils.js");
		const newFilePath = join(fixture.root, "lib/helpers/isSpecCompliantForm.js");
		let utils = await readFile(utilsPath, "utf-8");

		const fnMatch = utils.match(/function isSpecCompliantForm\(thing\) \{[\s\S]*?\n\}/);
		if (!fnMatch) throw new Error("could not find isSpecCompliantForm in the real fixture source");
		await writeFile(newFilePath, `export default ${fnMatch[0].replace("function isSpecCompliantForm(thing)", "function isSpecCompliantForm(thing)")}\n`);

		utils = utils.replace(`${fnMatch[0]}\n\n`, "");
		utils = `import isSpecCompliantForm from './helpers/isSpecCompliantForm.js';\n${utils}`;

		const task = CTF_CORPUS_TYPESCRIPT_MEDIUM.find((entry) => entry.id === "move-isSpecCompliantForm-to-new-file");
		if (!task) throw new Error("task not found");
		await writeFile(utilsPath, utils);
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(true);
	}, 30_000);

	it("move-isSpecCompliantForm-to-new-file: scores a copy-not-move (left behind in utils.js) as a failure", async () => {
		fixture = materializeTypescriptMediumAxiosFixture();
		const newFilePath = join(fixture.root, "lib/helpers/isSpecCompliantForm.js");
		await writeFile(newFilePath, "export default function isSpecCompliantForm(thing) { return true; }\n");
		// lib/utils.js still defines isSpecCompliantForm itself -- never actually removed.

		const task = CTF_CORPUS_TYPESCRIPT_MEDIUM.find((entry) => entry.id === "move-isSpecCompliantForm-to-new-file");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 30_000);
});
