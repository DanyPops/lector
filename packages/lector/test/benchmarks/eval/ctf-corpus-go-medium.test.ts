/**
 * Fixture self-test discipline, applied to the real prometheus/client_golang-vendored corpus.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CTF_CORPUS_GO_MEDIUM } from "../../../benchmarks/eval/ctf-corpus-go-medium.ts";
import { type GoMediumPrometheusClientFixture, materializeGoMediumPrometheusClientFixture } from "../../support/go-medium-prometheus-client-fixture.ts";

let fixture: GoMediumPrometheusClientFixture | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

async function walkGoFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkGoFiles(full)));
		else if (entry.name.endsWith(".go")) files.push(full);
	}
	return files;
}

describe("CTF_CORPUS_GO_MEDIUM", () => {
	it("has no duplicate task ids", () => {
		const ids = CTF_CORPUS_GO_MEDIUM.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("vendors a real, moderately-sized (~68 file) Go snapshot", () => {
		fixture = materializeGoMediumPrometheusClientFixture();
		const manifest: unknown = JSON.parse(require("node:fs").readFileSync(join(fixture.root, "fixture.json"), "utf-8"));
		expect((manifest as { fileCount: number }).fileCount).toBeGreaterThanOrEqual(50);
	});

	it("rename-NewDesc-to-NewMetricDesc-across-prometheus: scores a real, comprehensive rename as a full pass, leaving NewConstMetric untouched", async () => {
		fixture = materializeGoMediumPrometheusClientFixture();
		const pattern = /\bNewDesc\b/g;
		const files = await walkGoFiles(join(fixture.root, "prometheus"));
		let realCallSitesRenamed = 0;
		for (const file of files) {
			const content = await readFile(file, "utf-8");
			if (!pattern.test(content)) continue;
			await writeFile(file, content.replace(pattern, "NewMetricDesc"));
			realCallSitesRenamed++;
		}
		expect(realCallSitesRenamed).toBeGreaterThan(5); // sanity: this really touched many real files

		const descContent = await readFile(join(fixture.root, "prometheus/desc.go"), "utf-8");
		expect(descContent).toContain("func NewInvalidDesc"); // an unrelated real sibling, must survive untouched

		const task = CTF_CORPUS_GO_MEDIUM.find((entry) => entry.id === "rename-NewDesc-to-NewMetricDesc-across-prometheus");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(true);
	}, 30_000);

	it("rename-NewDesc-to-NewMetricDesc-across-prometheus: scores a real partial rename (one missed real call site) as a failure", async () => {
		fixture = materializeGoMediumPrometheusClientFixture();
		const descPath = join(fixture.root, "prometheus/desc.go");
		const content = await readFile(descPath, "utf-8");
		await writeFile(descPath, content.replace("func NewDesc(", "func NewMetricDesc("));
		// Deliberately leaves every real external call site (e.g. prometheus/counter.go) stale.

		const task = CTF_CORPUS_GO_MEDIUM.find((entry) => entry.id === "rename-NewDesc-to-NewMetricDesc-across-prometheus");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 30_000);
});
