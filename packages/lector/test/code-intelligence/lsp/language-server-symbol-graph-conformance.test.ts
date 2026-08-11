/**
 * populateSymbolGraph only depends on CodeIntelligencePort, never on a
 * specific descriptor. Proven here against two real non-TypeScript servers
 * (gopls, rust-analyzer) -- populate-symbol-graph.test.ts covers TypeScript.
 * Also checks the resulting graph against real structural invariants.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CPP_DESCRIPTOR, GO_DESCRIPTOR, PYTHON_DESCRIPTOR, RUST_DESCRIPTOR } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { InMemorySymbolGraph } from "../../../src/symbol-graph/in-memory-symbol-graph.ts";
import { populateSymbolGraph } from "../../../src/symbol-graph/populate-symbol-graph.ts";
import { deriveSymbolNodeId } from "../../../src/symbol-graph/symbol-node-id.ts";
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

	it("degrades gracefully, not as a recorded failure, when a Go function calls through a function-typed parameter -- the real live finding: gopls' own outgoingCalls throws '<name> is not a function' for the whole response rather than omitting just that one callee", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-go-higher-order-fixture-"));
		fixtureRoot = root;
		writeFileSync(join(root, "go.mod"), "module fixture\n\ngo 1.22\n");
		const mainFile = join(root, "main.go");
		writeFileSync(
			mainFile,
			"package main\n\ntype Handler func(int) int\n\nfunc double(x int) int {\n\treturn x * 2\n}\n\nfunc dispatch(h Handler, x int) int {\n\treturn h(x)\n}\n\nfunc run() int {\n\treturn dispatch(double, 5)\n}\n",
		);
		index = new LspSymbolIndex(root, GO_DESCRIPTOR, "main.go");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, [mainFile], 50);

		expect(result).toMatchObject({ completeness: "complete", filesProcessed: 1, failureCount: 0 });
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

	it("degrades gracefully, not as a recorded failure, when a Python function calls through a Callable-typed parameter -- the same higher-order-function shape that broke Go's outgoingCalls, confirmed clean against real pyright", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-python-higher-order-fixture-"));
		fixtureRoot = root;
		writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "fixture"\nversion = "0.1.0"\n');
		const mainFile = join(root, "main.py");
		writeFileSync(
			mainFile,
			[
				"from typing import Callable",
				"",
				"Handler = Callable[[int], int]",
				"",
				"def double(x: int) -> int:",
				"    return x * 2",
				"",
				"def dispatch(h: Handler, x: int) -> int:",
				"    return h(x)",
				"",
				"def run() -> int:",
				"    return dispatch(double, 5)",
				"",
			].join("\n"),
		);
		index = new LspSymbolIndex(root, PYTHON_DESCRIPTOR, "main.py");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, [mainFile], 50);

		expect(result).toMatchObject({ completeness: "complete", filesProcessed: 1, failureCount: 0 });
	}, 60_000);

	it("builds a real Python 'calls' chain across decorators, a property, static/classmethod, and a nested closure, with no structural invariant violations", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-python-graph-fixture-"));
		fixtureRoot = root;
		writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "fixture"\nversion = "0.1.0"\n');
		const mainFile = join(root, "main.py");
		writeFileSync(
			mainFile,
			[
				"class Account:",
				"    def __init__(self, balance: int) -> None:",
				"        self.balance = balance",
				"",
				"    def add(self, amount: int) -> int:",
				"        return self.balance + amount",
				"",
				"    def deposit(self, amount: int) -> int:",
				"        self.balance = self.add(amount)",
				"        return self.balance",
				"",
				"    @property",
				"    def display(self) -> str:",
				"        return f'balance={self.balance}'",
				"",
				"    @staticmethod",
				"    def zero() -> int:",
				"        return 0",
				"",
				"    @classmethod",
				"    def create(cls) -> 'Account':",
				"        return cls(cls.zero())",
				"",
				"def run() -> int:",
				"    def helper(y: int) -> int:",
				"        return y + 1",
				"    account = Account.create()",
				"    account.deposit(10)",
				"    return helper(account.balance)",
				"",
			].join("\n"),
		);
		index = new LspSymbolIndex(root, PYTHON_DESCRIPTOR, "main.py");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, [mainFile], 50);
		expect(result.filesProcessed).toBe(1);
		expect(result.failureCount).toBe(0);

		const depositPosition = findPositionOf(mainFile, "def deposit");
		const depositId = deriveSymbolNodeId({ path: mainFile, line: depositPosition.line, character: depositPosition.character + "def ".length });
		const callees = await graph.edgesFrom(depositId, "calls");
		const calleeNames = await Promise.all(callees.map(async (id) => (await graph?.getNode(id))?.name));
		expect(calleeNames).toContain("add");

		// pyright nests each method's own parameters as "contains" children (confirmed live via
		// documentSymbols/nodesAtLine) -- unlike gopls/rust-analyzer's flatter shape, so a real
		// invariant check here needs every node actually populated for this file, not just the
		// hand-picked calls-chain path, or an untouched real child reads as a false-positive
		// dangling edge purely because this test never asked about it.
		const lineCount = readFileSync(mainFile, "utf8").split("\n").length;
		const allNodeIds = (await Promise.all(Array.from({ length: lineCount }, (_unused, line) => graph?.nodesAtLine(mainFile, line) ?? [])))
			.flat()
			.map((node) => node.id);
		expect(await findSymbolGraphInvariantViolations(graph, allNodeIds)).toEqual([]);
	}, 60_000);

	it("builds a real C++ 'calls' chain across a virtual override, inheritance, and a function template, with no structural invariant violations", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-cpp-graph-fixture-"));
		fixtureRoot = root;
		writeFileSync(join(root, "compile_flags.txt"), "-std=c++17\n");
		const mainFile = join(root, "main.cpp");
		writeFileSync(
			mainFile,
			[
				"class Shape {",
				"public:",
				"    virtual int area() const { return 0; }",
				"};",
				"",
				"class Square : public Shape {",
				"public:",
				"    Square(int side) : side_(side) {}",
				"    int area() const override { return side_ * side_; }",
				"private:",
				"    int side_;",
				"};",
				"",
				"template <typename T>",
				"T addOne(T x) { return x + 1; }",
				"",
				"int computeTotal(const Shape& shape) {",
				"    return addOne(shape.area());",
				"}",
				"",
				"int main() {",
				"    Square sq(4);",
				"    return computeTotal(sq);",
				"}",
				"",
			].join("\n"),
		);
		index = new LspSymbolIndex(root, CPP_DESCRIPTOR, "main.cpp");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, [mainFile], 50);
		expect(result.filesProcessed).toBe(1);
		expect(result.failureCount).toBe(0);

		const computeTotalPosition = findPositionOf(mainFile, "int computeTotal");
		const computeTotalId = deriveSymbolNodeId({
			path: mainFile,
			line: computeTotalPosition.line,
			character: computeTotalPosition.character + "int ".length,
		});
		const callees = await graph.edgesFrom(computeTotalId, "calls");
		const calleeNames = await Promise.all(callees.map(async (id) => (await graph?.getNode(id))?.name));
		expect(calleeNames).toContain("addOne");

		const allNodeIds = [computeTotalId, ...callees];
		expect(await findSymbolGraphInvariantViolations(graph, allNodeIds)).toEqual([]);
	}, 60_000);
});
