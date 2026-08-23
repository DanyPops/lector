/**
 * Fixture self-test discipline, applied to the tier-3 large corpus: hand-apply a real,
 * comprehensive rename across all ~36 real call sites in the vendored prettier/src snapshot, and
 * confirm the unrelated same-name-prefix `hasComments` (language-yaml) is never touched.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CTF_CORPUS_TYPESCRIPT_LARGE } from "../../../benchmarks/eval/ctf-corpus-typescript-large.ts";
import { materializeTypescriptLargePrettierFixture, type TypescriptLargePrettierFixture } from "../../support/typescript-large-prettier-fixture.ts";

let fixture: TypescriptLargePrettierFixture | undefined;
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
		else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) files.push(full);
	}
	return files;
}

describe("CTF_CORPUS_TYPESCRIPT_LARGE", () => {
	it("has no duplicate task ids", () => {
		const ids = CTF_CORPUS_TYPESCRIPT_LARGE.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("vendors a real, large (~530 file) JS snapshot, an order of magnitude bigger than the medium tier", () => {
		fixture = materializeTypescriptLargePrettierFixture();
		const manifest: unknown = JSON.parse(require("node:fs").readFileSync(join(fixture.root, "fixture.json"), "utf-8"));
		expect((manifest as { fileCount: number }).fileCount).toBeGreaterThanOrEqual(400);
	});

	it("rename-hasComment-to-nodeHasComment-across-src: scores a real, comprehensive rename across every real call site as a full pass, leaving the unrelated hasComments untouched", async () => {
		fixture = materializeTypescriptLargePrettierFixture();
		const pattern = /\bhasComment\b/g;
		const files = await walkJsFiles(join(fixture.root, "src"));
		let realCallSitesRenamed = 0;
		for (const file of files) {
			const content = await readFile(file, "utf-8");
			if (!pattern.test(content)) continue;
			const updated = content.replace(pattern, "nodeHasComment");
			await writeFile(file, updated);
			realCallSitesRenamed++;
		}
		expect(realCallSitesRenamed).toBeGreaterThan(20); // sanity: this really touched many real files

		// The unrelated hasComments (yaml) must never have been renamed to nodeHasComments.
		const yamlContent = await readFile(join(fixture.root, "src/language-yaml/utilities.js"), "utf-8");
		expect(yamlContent).toContain("function hasComments(");

		const task = CTF_CORPUS_TYPESCRIPT_LARGE.find((entry) => entry.id === "rename-hasComment-to-nodeHasComment-across-src");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(true);
	}, 30_000);

	it("rename-hasComment-to-nodeHasComment-across-src: scores a real partial rename (most call sites, but one file missed) as a failure", async () => {
		fixture = materializeTypescriptLargePrettierFixture();
		const pattern = /\bhasComment\b/g;
		const files = await walkJsFiles(join(fixture.root, "src"));
		const skipOne = files.find((file) => file.endsWith("language-js/print/class.js"));
		if (!skipOne) throw new Error("expected fixture file not found -- vendored snapshot may have changed");
		for (const file of files) {
			if (file === skipOne) continue; // deliberately leaves this one real call site stale
			const content = await readFile(file, "utf-8");
			if (!pattern.test(content)) continue;
			await writeFile(file, content.replace(pattern, "nodeHasComment"));
		}

		const task = CTF_CORPUS_TYPESCRIPT_LARGE.find((entry) => entry.id === "rename-hasComment-to-nodeHasComment-across-src");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 30_000);
});
