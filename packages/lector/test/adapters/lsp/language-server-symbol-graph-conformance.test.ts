/**
 * populateSymbolGraph only depends on CodeIntelligencePort, never on a
 * specific descriptor. Proven here against two real non-TypeScript servers
 * (gopls, rust-analyzer) -- populate-symbol-graph.test.ts covers TypeScript.
 * Also checks the resulting graph against real structural invariants.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySymbolGraph } from "../../../src/adapters/in-memory-symbol-graph.ts";
import { LspSymbolIndex } from "../../../src/adapters/lsp/lsp-symbol-index.ts";
import { GO_DESCRIPTOR, RUST_DESCRIPTOR } from "../../../src/domain/language-server-descriptor.ts";
import { populateSymbolGraph } from "../../../src/domain/populate-symbol-graph.ts";
import { deriveSymbolNodeId } from "../../../src/domain/symbol-node-id.ts";
import { findPositionOf } from "../../support/find-position.ts";
import { findSymbolGraphInvariantViolations } from "../../support/symbol-graph-invariants.ts";

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

describe("populateSymbolGraph across languages", () => {
	it("builds a real Go 'calls' chain with no structural invariant violations", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-go-graph-fixture-"));
		fixtureRoot = root;
		writeFileSync(join(root, "go.mod"), "module fixture\n\ngo 1.22\n");
		const mainFile = join(root, "main.go");
		writeFileSync(
			mainFile,
			"package main\n\nfunc add(a int, b int) int {\n\treturn a + b\n}\n\nfunc addTwice(a int, b int) int {\n\treturn add(a, b) + add(a, b)\n}\n",
		);
		index = new LspSymbolIndex(root, GO_DESCRIPTOR, "main.go");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, [mainFile], 50);
		expect(result.filesProcessed).toBe(1);
		expect(result.edgesAdded).toBeGreaterThan(0);

		const addTwicePosition = findPositionOf(mainFile, "func addTwice");
		const addTwiceId = deriveSymbolNodeId({ path: mainFile, line: addTwicePosition.line, character: addTwicePosition.character + "func ".length });
		const callees = await graph.edgesFrom(addTwiceId, "calls");
		const calleeNames = await Promise.all(callees.map(async (id) => (await graph?.getNode(id))?.name));
		expect(calleeNames).toContain("add");

		const allNodeIds = [addTwiceId, ...callees];
		expect(await findSymbolGraphInvariantViolations(graph, allNodeIds)).toEqual([]);
	}, 30_000);

	it("builds a real Rust 'calls' chain with no structural invariant violations", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-rust-graph-fixture-"));
		fixtureRoot = root;
		writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n');
		mkdirSync(join(root, "src"));
		const mainFile = join(root, "src", "main.rs");
		writeFileSync(
			mainFile,
			'fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\nfn add_twice(a: i32, b: i32) -> i32 {\n    add(a, b) + add(a, b)\n}\n\nfn main() {\n    println!("{}", add_twice(1, 2));\n}\n',
		);
		index = new LspSymbolIndex(root, RUST_DESCRIPTOR, "src/main.rs");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, [mainFile], 50);
		expect(result.filesProcessed).toBe(1);
		expect(result.edgesAdded).toBeGreaterThan(0);

		const addTwicePosition = findPositionOf(mainFile, "fn add_twice");
		const addTwiceId = deriveSymbolNodeId({ path: mainFile, line: addTwicePosition.line, character: addTwicePosition.character + "fn ".length });
		const callees = await graph.edgesFrom(addTwiceId, "calls");
		const calleeNames = await Promise.all(callees.map(async (id) => (await graph?.getNode(id))?.name));
		expect(calleeNames).toContain("add");

		const allNodeIds = [addTwiceId, ...callees];
		expect(await findSymbolGraphInvariantViolations(graph, allNodeIds)).toEqual([]);
	}, 30_000);
});
