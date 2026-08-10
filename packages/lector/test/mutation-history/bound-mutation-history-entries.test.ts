import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { boundMutationHistoryEntries } from "../../src/mutation-history/bound-mutation-history-entries.ts";
import type { MutationHistoryEntry } from "../../src/mutation-history/mutation-history.ts";

function entry(overrides: Partial<MutationHistoryEntry> = {}): MutationHistoryEntry {
	return {
		id: "entry-1",
		path: "a.ts",
		operation: "exactEdit",
		beforeContent: "before",
		beforeHash: contentHashOf("before"),
		afterHash: contentHashOf("after"),
		timestamp: 1,
		transactionId: null,
		...overrides,
	};
}

describe("boundMutationHistoryEntries", () => {
	it("passes small entries through untouched, not truncated", () => {
		const result = boundMutationHistoryEntries([entry()], 10, 1_000_000, 1_000_000);
		expect(result.truncated).toBe(false);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.beforeContent).toBe("before");
		expect(result.entries[0]?.beforeContentTruncated).toBe(false);
	});

	it("caps one entry's own beforeContent independently of the list byte budget", () => {
		const huge = "x".repeat(1_000);
		const result = boundMutationHistoryEntries([entry({ beforeContent: huge })], 10, 1_000_000, 100);
		expect(result.entries[0]?.beforeContent?.length).toBe(100);
		expect(result.entries[0]?.beforeContentTruncated).toBe(true);
	});

	it("never truncates a null beforeContent (a create has none to bound)", () => {
		const result = boundMutationHistoryEntries([entry({ beforeContent: null })], 10, 1_000_000, 10);
		expect(result.entries[0]?.beforeContent).toBeNull();
		expect(result.entries[0]?.beforeContentTruncated).toBe(false);
	});

	it("bounds the list itself by maxResults", () => {
		const entries = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })];
		const result = boundMutationHistoryEntries(entries, 2, 1_000_000, 1_000_000);
		expect(result.entries).toHaveLength(2);
		expect(result.truncated).toBe(true);
	});

	it("bounds the list itself by total serialized bytes even under maxResults", () => {
		const entries = [entry({ id: "a", beforeContent: "x".repeat(500) }), entry({ id: "b", beforeContent: "y".repeat(500) })];
		const result = boundMutationHistoryEntries(entries, 10, 600, 1_000_000);
		expect(result.entries.length).toBeLessThan(2);
		expect(result.truncated).toBe(true);
	});

	it("truncates every large entry's own content, not just the first, before applying the list budget", () => {
		const entries = [entry({ id: "a", beforeContent: "x".repeat(1_000) }), entry({ id: "b", beforeContent: "y".repeat(1_000) })];
		const result = boundMutationHistoryEntries(entries, 10, 1_000_000, 50);
		expect(result.entries.every((e) => e.beforeContent?.length === 50)).toBe(true);
		expect(result.entries.every((e) => e.beforeContentTruncated)).toBe(true);
	});
});
