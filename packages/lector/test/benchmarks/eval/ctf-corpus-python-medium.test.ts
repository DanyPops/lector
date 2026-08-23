/**
 * Fixture self-test discipline, applied to the real celery-vendored corpus: hand-apply a real,
 * comprehensive rename including the trickier lazy-module mapping in __init__.py, and a real
 * partial mistake (the mapping left stale) that would break `from celery import current_app` at
 * runtime, not just statically.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CTF_CORPUS_PYTHON_MEDIUM } from "../../../benchmarks/eval/ctf-corpus-python-medium.ts";
import { materializePythonMediumCeleryFixture, type PythonMediumCeleryFixture } from "../../support/python-medium-celery-fixture.ts";

let fixture: PythonMediumCeleryFixture | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

async function walkPyFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkPyFiles(full)));
		else if (entry.name.endsWith(".py")) files.push(full);
	}
	return files;
}

describe("CTF_CORPUS_PYTHON_MEDIUM", () => {
	it("has no duplicate task ids", () => {
		const ids = CTF_CORPUS_PYTHON_MEDIUM.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("vendors a real, moderately-sized (~161 file) Python snapshot", () => {
		fixture = materializePythonMediumCeleryFixture();
		const manifest: unknown = JSON.parse(require("node:fs").readFileSync(join(fixture.root, "fixture.json"), "utf-8"));
		expect((manifest as { fileCount: number }).fileCount).toBeGreaterThanOrEqual(100);
	});

	it("rename-current_app-to-active_app-across-celery: scores a real, comprehensive rename (including the lazy-module mapping) as a full pass", async () => {
		fixture = materializePythonMediumCeleryFixture();
		const pattern = /\bcurrent_app\b/g;
		const files = await walkPyFiles(join(fixture.root, "celery"));
		let realCallSitesRenamed = 0;
		for (const file of files) {
			const content = await readFile(file, "utf-8");
			if (!pattern.test(content)) continue;
			await writeFile(file, content.replace(pattern, "active_app"));
			realCallSitesRenamed++;
		}
		expect(realCallSitesRenamed).toBeGreaterThan(3); // sanity: this really touched several real files

		// current_task (a different proxy in the same file) must never have been touched.
		const stateContent = await readFile(join(fixture.root, "celery/_state.py"), "utf-8");
		expect(stateContent).toContain("current_task");

		const task = CTF_CORPUS_PYTHON_MEDIUM.find((entry) => entry.id === "rename-current_app-to-active_app-across-celery");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(true);
	}, 30_000);

	it("rename-current_app-to-active_app-across-celery: scores a real partial rename (the lazy-module mapping left stale) as a failure", async () => {
		fixture = materializePythonMediumCeleryFixture();
		const statePath = join(fixture.root, "celery/_state.py");
		const state = await readFile(statePath, "utf-8");
		// Renames the declaration but deliberately leaves __init__.py's own lazy-module mapping
		// dict untouched -- the real, plausible mistake this checker exists to catch (it would
		// break `from celery import current_app` at import time, not just statically).
		await writeFile(statePath, state.replace("current_app = Proxy(get_current_app)", "active_app = Proxy(get_current_app)"));

		const task = CTF_CORPUS_PYTHON_MEDIUM.find((entry) => entry.id === "rename-current_app-to-active_app-across-celery");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 30_000);
});
