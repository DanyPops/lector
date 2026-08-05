/**
 * Documents populateSymbolGraph's own contract, found while investigating a real production
 * bug (a 249-file workspace: one rename made the next call refuse with
 * ReferenceBasedRenameRequiresFreshGraph, repopulate cost ~5-6 minutes): this pure function
 * always walks exactly the file list it's given, with no skip logic of its own. Delta
 * selection (which files actually need reprocessing) is the caller's job -- see
 * service.ts's populateSymbolGraphHandler and test/service-symbol-graph-delta.test.ts for
 * where that selection now happens and is proven to work.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../../src/adapters/lsp/lsp-symbol-index.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/domain/language-server-descriptor.ts";
import type { CodeIntelligencePort } from "../../src/ports/code-intelligence-port.ts";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";
import { populateSymbolGraph } from "../../src/symbol-graph/populate-symbol-graph.ts";

let fixtureRoot: string | undefined;
let index: LspSymbolIndex | undefined;
let graph: InMemorySymbolGraph | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	await graph?.close();
	graph = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

interface CallLog {
	readonly documentSymbolsPaths: string[];
	readonly outgoingCallsPaths: string[];
}

/** Wraps a real CodeIntelligencePort, recording every path queried via documentSymbols/outgoingCalls -- the two operations populateSymbolGraph issues per file/symbol. Everything else delegates untouched. */
function instrumented(real: CodeIntelligencePort, log: CallLog): CodeIntelligencePort {
	return {
		provenance: real.provenance,
		provenanceForPath: real.provenanceForPath?.bind(real),
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
		outgoingCalls: async (at, options) => {
			log.outgoingCallsPaths.push(at.path);
			return real.outgoingCalls(at, options);
		},
		releaseFile: real.releaseFile?.bind(real),
		notifyFileChanged: real.notifyFileChanged?.bind(real),
		prepareRename: real.prepareRename?.bind(real),
		rename: real.rename?.bind(real),
		notifyFilesWillRename: real.notifyFilesWillRename?.bind(real),
		notifyFilesDidRename: real.notifyFilesDidRename?.bind(real),
	};
}

/** A chain of `fileCount` files, each importing and calling into the next -- every file has a real cross-file "calls" edge, so outgoingCalls resolution is genuinely exercised for every one, matching production's actual per-file LSP cost shape. */
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

describe("populateSymbolGraph: single-file change vs. full re-crawl (delta bug reproduction)", () => {
	it("re-queries every file's documentSymbols/outgoingCalls on a second pass, even though only one file's content changed", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-symbol-graph-delta-"));
		fixtureRoot = root;
		const fileCount = 40;
		const files = buildChainFixture(root, fileCount);
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "f0.ts");
		graph = new InMemorySymbolGraph();

		const firstPassLog: CallLog = { documentSymbolsPaths: [], outgoingCallsPaths: [] };
		const firstPassStart = performance.now();
		const firstResult = await populateSymbolGraph(instrumented(index, firstPassLog), graph, files, 50);
		const firstPassMs = performance.now() - firstPassStart;

		expect(firstResult.completeness).toBe("complete");
		expect(firstResult.filesProcessed).toBe(fileCount);
		expect(firstPassLog.documentSymbolsPaths).toHaveLength(fileCount);

		// Change exactly ONE file; the rest stay untouched.
		const untouchedFile = files[Math.floor(fileCount / 2)];
		if (!untouchedFile) throw new Error("fixture setup produced no file to leave untouched");
		const changedFile = files[0];
		if (!changedFile) throw new Error("fixture setup produced no file to change");
		writeFileSync(changedFile, `import { fn1 } from "./f1.ts";\nexport function fn0(x: number): number {\n\treturn fn1(x) + 2; // changed\n}\n`);

		// Mirrors populateSymbolGraphHandler exactly: passes the full file list every time.
		const secondPassLog: CallLog = { documentSymbolsPaths: [], outgoingCallsPaths: [] };
		const secondPassStart = performance.now();
		const secondResult = await populateSymbolGraph(instrumented(index, secondPassLog), graph, files, 50);
		const secondPassMs = performance.now() - secondPassStart;

		expect(secondResult.completeness).toBe("complete");
		expect(secondResult.filesProcessed).toBe(fileCount);

		// The bug: every unchanged file was re-queried identically to the first pass. A real
		// delta implementation would query at most the changed file and its referrers.
		expect(secondPassLog.documentSymbolsPaths).toHaveLength(fileCount);
		expect(secondPassLog.documentSymbolsPaths.sort()).toEqual(firstPassLog.documentSymbolsPaths.sort());
		expect(secondPassLog.documentSymbolsPaths).toContain(untouchedFile);

		// Timing recorded, not asserted: a warm tsserver answers the identical second crawl
		// faster than the first from its own internal cache, unrelated to any skip logic here --
		// too noisy at this fixture size to assert without flaking. Call counts above are the
		// real, deterministic proof.
		console.log(`[populate-symbol-graph-delta] fileCount=${fileCount} firstPassMs=${firstPassMs.toFixed(1)} secondPassMs=${secondPassMs.toFixed(1)}`);
	}, 60_000);
});
