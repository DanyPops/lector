import { describe, expect, it } from "bun:test";
import { findDependentFiles } from "../../src/symbol-graph/find-dependent-files.ts";
import type { SymbolNode } from "../../src/symbol-graph/port.ts";
import { deriveSymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";

function node(id: string, path: string): SymbolNode {
	return { id: deriveSymbolNodeId({ path: id, line: 1, character: 1 }), name: id, kind: "function", location: { path, line: 1, character: 1 } };
}

describe("findDependentFiles", () => {
	it("finds a caller file with a direct edge into a changed file's node", () => {
		const callerNode = node("caller", "/caller.ts");
		const calleeNode = node("callee", "/changed.ts");
		const nodes = [callerNode, calleeNode];
		const edges = [{ from: callerNode.id, to: calleeNode.id, kind: "calls" as const }];

		const dependents = findDependentFiles(nodes, edges, new Set(["/changed.ts"]));

		expect(dependents).toEqual(new Set(["/caller.ts"]));
	});

	it("never includes the changed file itself, even if it calls its own symbol", () => {
		const a = node("a", "/changed.ts");
		const b = node("b", "/changed.ts");
		const edges = [{ from: a.id, to: b.id, kind: "calls" as const }];

		const dependents = findDependentFiles([a, b], edges, new Set(["/changed.ts"]));

		expect(dependents).toEqual(new Set());
	});

	it("ignores an edge unrelated to any changed file", () => {
		const a = node("a", "/x.ts");
		const b = node("b", "/y.ts");
		const edges = [{ from: a.id, to: b.id, kind: "calls" as const }];

		const dependents = findDependentFiles([a, b], edges, new Set(["/changed.ts"]));

		expect(dependents).toEqual(new Set());
	});

	it("returns an empty set for an empty graph", () => {
		expect(findDependentFiles([], [], new Set(["/changed.ts"]))).toEqual(new Set());
	});
});
