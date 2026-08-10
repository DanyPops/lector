import { describe, expect, it } from "bun:test";
import { nearestDeclarationAt } from "../../src/symbol-annotation/nearest-declaration-fallback.ts";
import type { SymbolNode } from "../../src/symbol-graph/port.ts";
import { deriveSymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";

function node(character: number, name = "x"): SymbolNode {
	return { id: deriveSymbolNodeId({ path: "a.ts", line: 1, character }), name, kind: "variable", location: { path: "a.ts", line: 1, character } };
}

describe("nearestDeclarationAt", () => {
	it("returns undefined for an empty candidate list", () => {
		expect(nearestDeclarationAt([], 5)).toBeUndefined();
	});

	it("returns the only candidate regardless of exact distance", () => {
		const only = node(10);
		expect(nearestDeclarationAt([only], 3)).toBe(only);
	});

	it("picks the closer of two candidates by character distance", () => {
		const near = node(8);
		const far = node(20);
		expect(nearestDeclarationAt([far, near], 9)).toBe(near);
	});

	it("refuses to guess when two candidates are exactly equidistant -- ambiguous, not resolved", () => {
		const left = node(5);
		const right = node(15);
		expect(nearestDeclarationAt([left, right], 10)).toBeUndefined();
	});

	it("matches an exact character hit with distance zero", () => {
		const exact = node(7);
		const other = node(20);
		expect(nearestDeclarationAt([other, exact], 7)).toBe(exact);
	});
});
