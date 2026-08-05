/**
 * Performance proof for the delta fix (service.ts's populateSymbolGraphHandler), same-workload
 * control-vs-candidate per this project's convention: control is the workspace's first, full
 * populate; candidate is a second populate after exactly one file changed. Distinct from
 * test/service-symbol-graph-delta.test.ts (correctness: which files got reprocessed) and
 * populate-symbol-graph-delta.perf.test.ts (documents the pre-fix pure-function contract this
 * bug came from) -- this file is the one place the fix's actual wall-clock win is measured.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../../src/adapters/lsp/lsp-symbol-index.ts";
import { createLectorService, type LectorService } from "../../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

/** A chain of `fileCount` files, each importing and calling into the next. */
function buildChainFixture(root: string, fileCount: number): string[] {
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	const files: string[] = [];
	for (let n = 0; n < fileCount; n++) {
		const next = n + 1;
		const body =
			next < fileCount
				? `import { fn${next} } from "./f${next}.ts";\nexport function fn${n}(x: number): number {\n\treturn fn${next}(x) + 1;\n}\n`
				: `export function fn${n}(x: number): number {\n\treturn x;\n}\n`;
		const file = join(root, `f${n}.ts`);
		writeFileSync(file, body);
		files.push(file);
	}
	return files;
}

describe("populateSymbolGraphHandler: delta repopulate wall-clock win", () => {
	it("repopulates meaningfully faster after one file changes than the original full populate, at real workspace-shaped scale", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-service-delta-perf-"));
		fixtureRoot = root;
		const fileCount = 60;
		const files = buildChainFixture(root, fileCount);
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "fn0", seedFile: "f0.ts" });

		const firstStart = performance.now();
		const firstResult = await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });
		const firstMs = performance.now() - firstStart;
		expect(firstResult.completeness).toBe("complete");
		expect(firstResult.filesProcessed).toBe(fileCount);

		// One file changed, deep in the middle of the chain -- a real "one caller, one callee"
		// blast radius, not the whole workspace.
		const changedIndex = 30;
		const changedFile = files[changedIndex];
		if (!changedFile) throw new Error("fixture setup produced no file to change");
		writeFileSync(
			changedFile,
			`import { fn${changedIndex + 1} } from "./f${changedIndex + 1}.ts";\nexport function fn${changedIndex}(x: number): number {\n\treturn fn${changedIndex + 1}(x) + 2;\n}\n`,
		);

		const secondStart = performance.now();
		const secondResult = await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });
		const secondMs = performance.now() - secondStart;
		expect(secondResult.completeness).toBe("complete");
		expect(secondResult.filesProcessed).toBe(fileCount);

		console.log(
			`[populate-symbol-graph-delta-fix] fileCount=${fileCount} firstMs=${firstMs.toFixed(1)} secondMs=${secondMs.toFixed(1)} ratio=${(firstMs / secondMs).toFixed(2)}x`,
		);

		// A real, measured win, not a coincidence: at 60 files, the fix reprocesses only 1-2 of
		// them instead of 60. A generous 3x bound (real measured ratio is far higher) tolerates
		// warm-server variance while still catching a real regression back toward full rescan.
		expect(secondMs).toBeLessThan(firstMs / 3);
	}, 60_000);
});
