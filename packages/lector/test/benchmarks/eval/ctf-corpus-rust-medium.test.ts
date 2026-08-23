/**
 * Fixture self-test discipline, applied to the real ripgrep-vendored corpus.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CTF_CORPUS_RUST_MEDIUM } from "../../../benchmarks/eval/ctf-corpus-rust-medium.ts";
import { materializeRustMediumRipgrepFixture, type RustMediumRipgrepFixture } from "../../support/rust-medium-ripgrep-fixture.ts";

let fixture: RustMediumRipgrepFixture | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

async function walkRsFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkRsFiles(full)));
		else if (entry.name.endsWith(".rs")) files.push(full);
	}
	return files;
}

describe("CTF_CORPUS_RUST_MEDIUM", () => {
	it("has no duplicate task ids", () => {
		const ids = CTF_CORPUS_RUST_MEDIUM.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("vendors a real, moderately-sized (~90 file) Rust multi-crate workspace", () => {
		fixture = materializeRustMediumRipgrepFixture();
		const manifest: unknown = JSON.parse(require("node:fs").readFileSync(join(fixture.root, "fixture.json"), "utf-8"));
		expect((manifest as { fileCount: number }).fileCount).toBeGreaterThanOrEqual(50);
	});

	it("rename-SearcherBuilder-to-SearchEngineBuilder-across-crates: scores a real, comprehensive cross-crate rename as a full pass, leaving Searcher untouched", async () => {
		fixture = materializeRustMediumRipgrepFixture();
		const pattern = /\bSearcherBuilder\b/g;
		const files = await walkRsFiles(join(fixture.root, "crates"));
		let realCallSitesRenamed = 0;
		for (const file of files) {
			const content = await readFile(file, "utf-8");
			if (!pattern.test(content)) continue;
			await writeFile(file, content.replace(pattern, "SearchEngineBuilder"));
			realCallSitesRenamed++;
		}
		expect(realCallSitesRenamed).toBeGreaterThanOrEqual(5); // sanity: this really touched several real, cross-crate files

		const modContent = await readFile(join(fixture.root, "crates/searcher/src/searcher/mod.rs"), "utf-8");
		expect(modContent).toContain("pub struct Searcher {"); // the unrelated real sibling, must survive untouched

		const task = CTF_CORPUS_RUST_MEDIUM.find((entry) => entry.id === "rename-SearcherBuilder-to-SearchEngineBuilder-across-crates");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(true);
	}, 30_000);

	it("rename-SearcherBuilder-to-SearchEngineBuilder-across-crates: scores a real partial rename (a cross-crate consumer left stale) as a failure", async () => {
		fixture = materializeRustMediumRipgrepFixture();
		const modPath = join(fixture.root, "crates/searcher/src/searcher/mod.rs");
		const content = await readFile(modPath, "utf-8");
		await writeFile(modPath, content.replace("pub struct SearcherBuilder {", "pub struct SearchEngineBuilder {"));
		// Deliberately leaves every real cross-crate consumer (e.g. crates/printer/src/json.rs) stale.

		const task = CTF_CORPUS_RUST_MEDIUM.find((entry) => entry.id === "rename-SearcherBuilder-to-SearchEngineBuilder-across-crates");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 30_000);
});
