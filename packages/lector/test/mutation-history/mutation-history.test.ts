import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import type { MutationHistoryEntry } from "../../src/mutation-history/mutation-history.ts";
import { canRevertMutation } from "../../src/mutation-history/mutation-history.ts";

function entry(overrides: Partial<MutationHistoryEntry> = {}): MutationHistoryEntry {
	return {
		id: "1",
		path: "a.ts",
		operation: "exactEdit",
		beforeContent: "before",
		beforeHash: contentHashOf("before"),
		afterHash: contentHashOf("after"),
		timestamp: 0,
		...overrides,
	};
}

describe("canRevertMutation", () => {
	it("allows a revert when the file's current content is exactly what this mutation produced", () => {
		expect(canRevertMutation({ entry: entry(), currentHash: contentHashOf("after") })).toBe(true);
	});

	it("refuses a revert when the file has changed since this mutation, rather than silently clobbering the newer change", () => {
		expect(canRevertMutation({ entry: entry(), currentHash: contentHashOf("something else entirely") })).toBe(false);
	});

	it("refuses a revert when the file no longer exists at all", () => {
		expect(canRevertMutation({ entry: entry(), currentHash: null })).toBe(false);
	});

	it("allows reverting a mutation whose own beforeContent was 'the file didn't exist yet' (a create)", () => {
		expect(canRevertMutation({ entry: entry({ beforeContent: null, beforeHash: null }), currentHash: contentHashOf("after") })).toBe(true);
	});

	it("allows reverting a mutation whose own result was 'the file no longer exists' (a delete/revert-of-a-create), when it still doesn't exist", () => {
		expect(canRevertMutation({ entry: entry({ afterHash: null }), currentHash: null })).toBe(true);
	});

	it("refuses reverting a delete-shaped mutation when the file has since been recreated", () => {
		expect(canRevertMutation({ entry: entry({ afterHash: null }), currentHash: contentHashOf("recreated") })).toBe(false);
	});
});
