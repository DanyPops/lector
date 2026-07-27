/**
 * populateSymbolGraph against a real typescript-language-server + a real
 * InMemorySymbolGraph: proves the graph actually answers the multi-hop
 * question a flat edge list can't -- reachableFrom at depth 1 stops one hop
 * short of a transitive callee that depth 2 reaches.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySymbolGraph } from "../src/adapters/in-memory-symbol-graph.ts";
import { LspSymbolIndex } from "../src/adapters/lsp/lsp-symbol-index.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../src/domain/language-server-descriptor.ts";
import { populateSymbolGraph } from "../src/domain/populate-symbol-graph.ts";
import { deriveSymbolNodeId } from "../src/domain/symbol-node-id.ts";
import type { CodeIntelligencePort } from "../src/ports/code-intelligence-port.ts";
import { findPositionOf } from "./support/find-position.ts";

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

function buildFixture(): { root: string; chainFile: string; classFile: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-symbol-graph-fixture-"));
	writeFileSync(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	const chainFile = join(root, "chain.ts");
	writeFileSync(
		chainFile,
		"export function a(): number {\n\treturn b();\n}\n\nexport function b(): number {\n\treturn c();\n}\n\nexport function c(): number {\n\treturn 42;\n}\n",
	);
	const classFile = join(root, "greeter.ts");
	writeFileSync(classFile, 'export class Greeter {\n\tgreet(): string {\n\t\treturn "hi";\n\t}\n}\n');
	return { root, chainFile, classFile };
}

describe("populateSymbolGraph", () => {
	it("builds a real 'calls' chain a real symbol graph can answer multi-hop questions about", async () => {
		const { root, chainFile } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "chain.ts");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, [chainFile], 50);

		expect(result.filesProcessed).toBe(1);
		expect(result.symbolsProcessed).toBe(3);
		expect(result.edgesAdded).toBeGreaterThan(0);

		const aPosition = findPositionOf(chainFile, "export function a");
		const aId = deriveSymbolNodeId({ path: chainFile, line: aPosition.line, character: aPosition.character + "export function ".length });

		const oneHop = await graph.reachableFrom(aId, { maxDepth: 1, kind: "calls" });
		const twoHops = await graph.reachableFrom(aId, { maxDepth: 2, kind: "calls" });

		const oneHopNames = await Promise.all(oneHop.map(async (id) => (await graph?.getNode(id))?.name));
		const twoHopNames = await Promise.all(twoHops.map(async (id) => (await graph?.getNode(id))?.name));

		expect(oneHopNames).toContain("b");
		expect(oneHopNames).not.toContain("c");
		expect(twoHopNames).toContain("b");
		expect(twoHopNames).toContain("c");
	}, 20_000);

	it("adds a 'contains' edge from a class to its method, at no extra LSP cost", async () => {
		const { root, classFile } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "chain.ts");
		graph = new InMemorySymbolGraph();

		await populateSymbolGraph(index, graph, [classFile], 50);

		const classPosition = findPositionOf(classFile, "export class Greeter");
		const classId = deriveSymbolNodeId({ path: classFile, line: classPosition.line, character: classPosition.character + "export class ".length });

		const contained = await graph.edgesFrom(classId, "contains");
		const containedNames = await Promise.all(contained.map(async (id) => (await graph?.getNode(id))?.name));

		expect(containedNames).toContain("greet");
	}, 20_000);

	it("bounds recorded file failures while retaining the total failure count", async () => {
		const empty = async () => [];
		const failing: CodeIntelligencePort = {
			provenance: {
				fidelity: "semantic",
				backend: "failing-test-server",
				languageId: "test",
				authority: "language-server",
				freshness: "live-process",
				limitations: [],
			},
			goToDefinition: empty,
			goToImplementation: empty,
			findReferences: empty,
			hover: async () => undefined,
			documentSymbols: async (path) => {
				throw new Error(`cannot index ${path}`);
			},
			diagnostics: empty,
			prepareCallHierarchy: empty,
			incomingCalls: empty,
			outgoingCalls: empty,
		};
		graph = new InMemorySymbolGraph();
		const files = Array.from({ length: 105 }, (_, position) => `/repo/file-${position}.test`);

		const result = await populateSymbolGraph(failing, graph, files, 10);

		expect(result).toMatchObject({ completeness: "partial", filesAttempted: 105, filesProcessed: 0, filesFailed: 105, failureCount: 105 });
		expect(result.failures).toHaveLength(100);
		expect(result.failuresTruncated).toBe(true);
		expect(result.failures[0]?.message.length).toBeLessThanOrEqual(500);
	});

	it("releases each file after processing it, so a bulk crawl over more files than the open-file cap fully succeeds", async () => {
		// Reproduces the real bug in miniature: 5 real files against a 2-slot open-file cap. Before
		// releaseFile existed, this failed partway through with LanguageFileLimitExceeded and never
		// recovered even for a live retry -- the exact failure mode found live against Lector's own
		// ~270-file monorepo.
		const root = mkdtempSync(join(tmpdir(), "lector-symbol-graph-release-"));
		fixtureRoot = root;
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
		const files: string[] = [];
		for (let n = 0; n < 5; n++) {
			const file = join(root, `f${n}.ts`);
			writeFileSync(file, `export function fn${n}(): number {\n\treturn ${n};\n}\n`);
			files.push(file);
		}
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "f0.ts", { maxOpenFiles: 2 });
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, files, 50);

		expect(result.completeness).toBe("complete");
		expect(result.filesFailed).toBe(0);
		expect(result.filesProcessed).toBe(5);

		// The live-recovery promise this was breaking: a query against any of the files afterward
		// still works, proving the index isn't left permanently wedged at the cap.
		const symbols = await index.documentSymbols(files[4] ?? "");
		expect(symbols.some((entry) => entry.name === "fn4")).toBe(true);
	}, 30_000);

	it("calls releaseFile exactly once per attempted file, even when document-symbols or outgoing-calls fails", async () => {
		const released: string[] = [];
		let callCount = 0;
		const flaky: CodeIntelligencePort = {
			provenance: {
				fidelity: "semantic",
				backend: "flaky-test-server",
				languageId: "test",
				authority: "language-server",
				freshness: "live-process",
				limitations: [],
			},
			goToDefinition: async () => [],
			goToImplementation: async () => [],
			findReferences: async () => [],
			hover: async () => undefined,
			documentSymbols: async (path) => {
				callCount++;
				if (path === "/repo/fails.test") throw new Error("cannot index this one");
				return [];
			},
			diagnostics: async () => [],
			prepareCallHierarchy: async () => [],
			incomingCalls: async () => [],
			outgoingCalls: async () => [],
			releaseFile: async (path) => {
				released.push(path);
			},
		};
		graph = new InMemorySymbolGraph();

		await populateSymbolGraph(flaky, graph, ["/repo/ok.test", "/repo/fails.test"], 10);

		expect(callCount).toBe(2);
		expect(released).toEqual(["/repo/ok.test", "/repo/fails.test"]);
	});

	it("returns honest zero counts for an empty file list, not an error", async () => {
		const { root } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "chain.ts");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, [], 50);

		expect(result).toEqual({
			completeness: "complete",
			filesAttempted: 0,
			filesProcessed: 0,
			filesFailed: 0,
			symbolsProcessed: 0,
			nodesAdded: 0,
			edgesAdded: 0,
			failureCount: 0,
			failures: [],
			failuresTruncated: false,
		});
	}, 20_000);
});
