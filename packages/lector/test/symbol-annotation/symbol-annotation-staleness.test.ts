import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/domain/content-hash.ts";
import type { SymbolAnnotationAnchor } from "../../src/symbol-annotation/symbol-annotation.ts";
import { isAnnotationStale } from "../../src/symbol-annotation/symbol-annotation-staleness.ts";

const HASH_A = contentHashOf("content A");
const HASH_B = contentHashOf("content B");

function anchor(symbolNodeId: string, path: string, fileContentHash = HASH_A): SymbolAnnotationAnchor {
	return { symbolNodeId, path, fileContentHash };
}

describe("isAnnotationStale", () => {
	it("is not stale when every anchor exists and its file hash is unchanged", () => {
		const anchors = [anchor("a.ts:1:1", "a.ts"), anchor("b.ts:1:1", "b.ts")];
		const reality = new Map([
			["a.ts:1:1", { exists: true, currentFileHash: HASH_A }],
			["b.ts:1:1", { exists: true, currentFileHash: HASH_A }],
		]);
		expect(isAnnotationStale(anchors, reality)).toBe(false);
	});

	it("is stale when any single anchor's node no longer exists", () => {
		const anchors = [anchor("a.ts:1:1", "a.ts"), anchor("b.ts:1:1", "b.ts")];
		const reality = new Map([
			["a.ts:1:1", { exists: true, currentFileHash: HASH_A }],
			["b.ts:1:1", { exists: false, currentFileHash: undefined }],
		]);
		expect(isAnnotationStale(anchors, reality)).toBe(true);
	});

	it("is stale when an anchor's file content hash changed, even though the node still exists at the same position", () => {
		const anchors = [anchor("a.ts:1:1", "a.ts", HASH_A)];
		const reality = new Map([["a.ts:1:1", { exists: true, currentFileHash: HASH_B }]]);
		expect(isAnnotationStale(anchors, reality)).toBe(true);
	});

	it("is stale when an anchor has no resolved reality at all (never checked)", () => {
		const anchors = [anchor("a.ts:1:1", "a.ts")];
		expect(isAnnotationStale(anchors, new Map())).toBe(true);
	});

	it("an annotation with zero anchors is never stale (vacuously true, nothing to invalidate it)", () => {
		expect(isAnnotationStale([], new Map())).toBe(false);
	});
});
