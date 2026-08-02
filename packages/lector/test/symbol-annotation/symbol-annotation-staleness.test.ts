import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/domain/content-hash.ts";
import type { SymbolAnnotationAnchor } from "../../src/symbol-annotation/symbol-annotation.ts";
import { isAnnotationStale } from "../../src/symbol-annotation/symbol-annotation-staleness.ts";
import { deriveSymbolNodeId, type SymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";

const HASH_A = contentHashOf("content A");
const HASH_B = contentHashOf("content B");
const A_ID = deriveSymbolNodeId({ path: "a.ts", line: 1, character: 1 });
const B_ID = deriveSymbolNodeId({ path: "b.ts", line: 1, character: 1 });

function anchor(symbolNodeId: SymbolNodeId, path: string, fileContentHash = HASH_A): SymbolAnnotationAnchor {
	return { symbolNodeId, path, fileContentHash };
}

describe("isAnnotationStale", () => {
	it("is not stale when every anchor exists and its file hash is unchanged", () => {
		const anchors = [anchor(A_ID, "a.ts"), anchor(B_ID, "b.ts")];
		const reality = new Map([
			[A_ID, { exists: true, currentFileHash: HASH_A }],
			[B_ID, { exists: true, currentFileHash: HASH_A }],
		]);
		expect(isAnnotationStale(anchors, reality)).toBe(false);
	});

	it("is stale when any single anchor's node no longer exists", () => {
		const anchors = [anchor(A_ID, "a.ts"), anchor(B_ID, "b.ts")];
		const reality = new Map([
			[A_ID, { exists: true, currentFileHash: HASH_A }],
			[B_ID, { exists: false, currentFileHash: undefined }],
		]);
		expect(isAnnotationStale(anchors, reality)).toBe(true);
	});

	it("is stale when an anchor's file content hash changed, even though the node still exists at the same position", () => {
		const anchors = [anchor(A_ID, "a.ts", HASH_A)];
		const reality = new Map([[A_ID, { exists: true, currentFileHash: HASH_B }]]);
		expect(isAnnotationStale(anchors, reality)).toBe(true);
	});

	it("is stale when an anchor has no resolved reality at all (never checked)", () => {
		const anchors = [anchor(A_ID, "a.ts")];
		expect(isAnnotationStale(anchors, new Map())).toBe(true);
	});

	it("an annotation with zero anchors is never stale (vacuously true, nothing to invalidate it)", () => {
		expect(isAnnotationStale([], new Map())).toBe(false);
	});
});
