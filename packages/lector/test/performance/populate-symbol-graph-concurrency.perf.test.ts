/**
 * Second bottleneck found alongside the delta-rescan bug
 * (populate-symbol-graph-delta.perf.test.ts): populateSymbolGraph's crawl
 * loop awaits one LSP round trip at a time, with zero concurrency, even
 * though every file is independent work. Measures sequential vs. concurrent
 * dispatch of the same request count against one warm server, using two
 * disjoint file sets so neither ordering benefits from the other's warm-cache
 * side effect (found directly while building the companion delta test).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";

let fixtureRoot: string | undefined;
let index: LspSymbolIndex | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

/** `count` fully independent files (no imports between them) under one shared tsconfig project, named with `prefix` so two disjoint sets can coexist in the same root. */
function buildIndependentFiles(root: string, prefix: string, count: number): string[] {
	const files: string[] = [];
	for (let n = 0; n < count; n++) {
		const file = join(root, `${prefix}${n}.ts`);
		writeFileSync(file, `export function ${prefix}${n}(x: number): number {\n\treturn x + ${n};\n}\n`);
		files.push(file);
	}
	return files;
}

describe("populateSymbolGraph's crawl loop: sequential vs. concurrent LSP dispatch", () => {
	it("answers the same independent-file documentSymbols workload meaningfully faster when dispatched concurrently than one-at-a-time", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-symbol-graph-concurrency-"));
		fixtureRoot = root;
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
		const fileCount = 30;
		const sequentialFiles = buildIndependentFiles(root, "seq", fileCount);
		const concurrentFiles = buildIndependentFiles(root, "conc", fileCount);
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "seq0.ts");

		// Warm the project once so neither measured group pays real project-load cost.
		await index.documentSymbols(join(root, "tsconfig.json").replace(/tsconfig\.json$/, "seq0.ts"));
		await index.releaseFile?.(sequentialFiles[0] ?? "");

		const sequentialStart = performance.now();
		for (const file of sequentialFiles) {
			await index.documentSymbols(file, { settleMs: 0 });
			await index.releaseFile?.(file);
		}
		const sequentialMs = performance.now() - sequentialStart;

		const concurrentStart = performance.now();
		await Promise.all(concurrentFiles.map((file) => index?.documentSymbols(file, { settleMs: 0 })));
		await Promise.all(concurrentFiles.map((file) => index?.releaseFile?.(file)));
		const concurrentMs = performance.now() - concurrentStart;

		console.log(`[populate-symbol-graph-concurrency] fileCount=${fileCount} sequentialMs=${sequentialMs.toFixed(1)} concurrentMs=${concurrentMs.toFixed(1)}`);

		// Measured ~1.5x-2x speedup at this fixture size; 1.3x margin absorbs normal variance
		// while still catching a regression toward parity.
		expect(concurrentMs).toBeLessThan(sequentialMs / 1.3);
	}, 60_000);
});
