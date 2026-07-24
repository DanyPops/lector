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
	writeFileSync(root + "/tsconfig.json", JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
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

	it("returns honest zero counts for an empty file list, not an error", async () => {
		const { root } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "chain.ts");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, [], 50);

		expect(result).toEqual({ filesProcessed: 0, symbolsProcessed: 0, nodesAdded: 0, edgesAdded: 0 });
	}, 20_000);
});
