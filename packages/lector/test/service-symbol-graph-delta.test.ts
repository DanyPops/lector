/**
 * End-to-end proof of the delta fix in populateSymbolGraphHandler: a second populate call
 * after editing one file in an otherwise-untouched workspace reprocesses only that file and
 * its real dependent (a file whose own edge pointed into the changed file's now-shifted
 * declaration) -- not the whole workspace. See test/performance/populate-symbol-graph-delta.perf.test.ts
 * for the underlying bug this fixes, and the pure-function contract it documents.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import type { CodeIntelligencePort } from "../src/code-intelligence/port.ts";
import type { ClosableSymbolIndex } from "../src/service/warm-index-registry.ts";
import { createLectorService, type LectorService } from "../src/service.ts";
import { findPositionOf } from "./support/find-position.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

interface CallLog {
	readonly documentSymbolsPaths: string[];
}

/** Wraps a real LspSymbolIndex, recording every path queried via documentSymbols. Everything else (including findSymbols/close, required for use as a service createSymbolIndex factory) delegates untouched. */
function instrumented(real: LspSymbolIndex, log: CallLog): ClosableSymbolIndex & CodeIntelligencePort {
	return {
		provenance: real.provenance,
		findSymbols: real.findSymbols.bind(real),
		close: real.close.bind(real),
		goToDefinition: real.goToDefinition.bind(real),
		goToImplementation: real.goToImplementation.bind(real),
		findReferences: real.findReferences.bind(real),
		hover: real.hover.bind(real),
		documentSymbols: async (path, options) => {
			log.documentSymbolsPaths.push(path);
			return real.documentSymbols(path, options);
		},
		diagnostics: real.diagnostics.bind(real),
		prepareCallHierarchy: real.prepareCallHierarchy.bind(real),
		incomingCalls: real.incomingCalls.bind(real),
		outgoingCalls: real.outgoingCalls.bind(real),
		releaseFile: real.releaseFile?.bind(real),
		notifyFileChanged: real.notifyFileChanged?.bind(real),
		prepareRename: real.prepareRename?.bind(real),
		rename: real.rename?.bind(real),
		notifyFilesWillRename: real.notifyFilesWillRename?.bind(real),
		notifyFilesDidRename: real.notifyFilesDidRename?.bind(real),
	};
}

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

describe("populateSymbolGraphHandler: delta repopulate", () => {
	it("reprocesses only a changed file and its real dependent, and keeps the caller's edge correct afterward", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-service-delta-"));
		fixtureRoot = root;
		const fileCount = 24;
		const files = buildChainFixture(root, fileCount);

		const log: CallLog = { documentSymbolsPaths: [] };
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => instrumented(new LspSymbolIndex(rootPath, descriptor, seedFile), log),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "fn0", seedFile: "f0.ts" });

		const firstStart = performance.now();
		const firstResult = await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });
		const firstMs = performance.now() - firstStart;
		expect(firstResult.completeness).toBe("complete");
		expect(firstResult.filesProcessed).toBe(fileCount);
		expect(log.documentSymbolsPaths).toHaveLength(fileCount);

		// Shift f10's own declaration down a line (a real position change, not just a body edit),
		// so its node id changes and f9's existing edge into it goes stale unless f9 is also
		// reprocessed.
		const changedIndex = 10;
		const callerIndex = changedIndex - 1;
		const changedFile = files[changedIndex];
		const callerFile = files[callerIndex];
		if (!changedFile || !callerFile) throw new Error("fixture setup produced no file to change/caller");
		writeFileSync(
			changedFile,
			`import { fn${changedIndex + 1} } from "./f${changedIndex + 1}.ts";\n// shifted\nexport function fn${changedIndex}(x: number): number {\n\treturn fn${changedIndex + 1}(x) + 1;\n}\n`,
		);

		log.documentSymbolsPaths.length = 0;
		const secondStart = performance.now();
		const secondResult = await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });
		const secondMs = performance.now() - secondStart;
		console.log(`[service-symbol-graph-delta] fileCount=${fileCount} firstMs=${firstMs.toFixed(1)} secondMs=${secondMs.toFixed(1)}`);

		// The fix: only the changed file and its real caller were re-walked, not all fileCount.
		expect(new Set(log.documentSymbolsPaths)).toEqual(new Set([changedFile, callerFile]));
		// Skipped files still count as processed at the workspace scope.
		expect(secondResult.completeness).toBe("complete");
		expect(secondResult.filesProcessed).toBe(fileCount);

		// Correctness, not just call counts: the caller's edge now resolves to fn10's NEW
		// (shifted) position, not a dangling reference to the old one.
		const callerPosition = findPositionOf(callerFile, `export function fn${callerIndex}`);
		const reachable = await service.dispatch("workspace.reachableFrom", {
			workspaceId,
			path: callerFile,
			line: callerPosition.line,
			character: callerPosition.character + "export function ".length,
			maxDepth: 1,
			kind: "calls",
		});
		expect(reachable.symbols.map((symbol) => symbol.name)).toContain(`fn${changedIndex}`);
	}, 30_000);

	it("reprocesses nothing when nothing changed", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-service-delta-noop-"));
		fixtureRoot = root;
		const fileCount = 12;
		buildChainFixture(root, fileCount);

		const log: CallLog = { documentSymbolsPaths: [] };
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => instrumented(new LspSymbolIndex(rootPath, descriptor, seedFile), log),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "fn0", seedFile: "f0.ts" });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });

		log.documentSymbolsPaths.length = 0;
		const result = await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });

		expect(log.documentSymbolsPaths).toHaveLength(0);
		expect(result.filesProcessed).toBe(fileCount);
		expect(result.completeness).toBe("complete");
	}, 30_000);
});
