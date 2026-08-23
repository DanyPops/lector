/**
 * Fixture self-test discipline, applied to the real libuv-vendored corpus.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CTF_CORPUS_CPP_MEDIUM } from "../../../benchmarks/eval/ctf-corpus-cpp-medium.ts";
import { type CppMediumLibuvFixture, materializeCppMediumLibuvFixture } from "../../support/cpp-medium-libuv-fixture.ts";

let fixture: CppMediumLibuvFixture | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

async function walkCFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkCFiles(full)));
		else if (entry.name.endsWith(".c") || entry.name.endsWith(".h")) files.push(full);
	}
	return files;
}

describe("CTF_CORPUS_CPP_MEDIUM", () => {
	it("has no duplicate task ids", () => {
		const ids = CTF_CORPUS_CPP_MEDIUM.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("vendors a real, moderately-sized (~118 file) C snapshot", () => {
		fixture = materializeCppMediumLibuvFixture();
		const manifest: unknown = JSON.parse(require("node:fs").readFileSync(join(fixture.root, "fixture.json"), "utf-8"));
		expect((manifest as { fileCount: number }).fileCount).toBeGreaterThanOrEqual(80);
	});

	it("rename-uv__handle_init-to-uv__handle_setup-across-src: scores a real, comprehensive macro rename as a full pass, leaving sibling macros untouched", async () => {
		fixture = materializeCppMediumLibuvFixture();
		const pattern = /\buv__handle_init\b/g;
		const files = [...(await walkCFiles(join(fixture.root, "src"))), ...(await walkCFiles(join(fixture.root, "include")))];
		let realCallSitesRenamed = 0;
		for (const file of files) {
			const content = await readFile(file, "utf-8");
			if (!pattern.test(content)) continue;
			await writeFile(file, content.replace(pattern, "uv__handle_setup"));
			realCallSitesRenamed++;
		}
		expect(realCallSitesRenamed).toBeGreaterThan(10); // sanity: this really touched many real files

		const commonHeader = await readFile(join(fixture.root, "src/uv-common.h"), "utf-8");
		expect(commonHeader).toContain("#define uv__handle_start("); // an unrelated real sibling, must survive untouched
		expect(commonHeader).toContain("#define uv__handle_stop(");

		const task = CTF_CORPUS_CPP_MEDIUM.find((entry) => entry.id === "rename-uv__handle_init-to-uv__handle_setup-across-src");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(true);
	}, 30_000);

	it("rename-uv__handle_init-to-uv__handle_setup-across-src: scores a real partial rename (most call sites, but one file missed) as a failure", async () => {
		fixture = materializeCppMediumLibuvFixture();
		const commonHeaderPath = join(fixture.root, "src/uv-common.h");
		const content = await readFile(commonHeaderPath, "utf-8");
		await writeFile(commonHeaderPath, content.replace("#define uv__handle_init(loop_, h, type_)", "#define uv__handle_setup(loop_, h, type_)"));
		// Deliberately leaves every real external call site (e.g. src/unix/core.c) stale.

		const task = CTF_CORPUS_CPP_MEDIUM.find((entry) => entry.id === "rename-uv__handle_init-to-uv__handle_setup-across-src");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 30_000);
});
