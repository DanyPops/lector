import { describe, expect, it } from "bun:test";
import type { ContentHash } from "../../src/content-identity/content-hash.ts";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import type { MutationHistoryEntry } from "../../src/mutation-history/mutation-history.ts";
import { planMutationTransactionRevert } from "../../src/mutation-history/plan-mutation-transaction-revert.ts";

function entry(overrides: Partial<MutationHistoryEntry> = {}): MutationHistoryEntry {
	return {
		id: "e1",
		path: "a.ts",
		operation: "rename",
		beforeContent: "before",
		beforeHash: contentHashOf("before"),
		afterHash: contentHashOf("after"),
		timestamp: 1,
		transactionId: "tx-1",
		...overrides,
	};
}

describe("planMutationTransactionRevert", () => {
	it("approves when every entry's own target still holds exactly what it produced", () => {
		const entries = [entry({ path: "a.ts", afterHash: contentHashOf("a-after") }), entry({ id: "e2", path: "b.ts", afterHash: contentHashOf("b-after") })];
		const currentHashes = new Map<string, ContentHash | null>([
			["a.ts", contentHashOf("a-after")],
			["b.ts", contentHashOf("b-after")],
		]);
		expect(planMutationTransactionRevert(entries, currentHashes)).toEqual({ safe: true });
	});

	it("refuses the whole transaction when even one member is stale, naming that entry", () => {
		const fresh = entry({ path: "a.ts", afterHash: contentHashOf("a-after") });
		const stale = entry({ id: "e2", path: "b.ts", afterHash: contentHashOf("b-after") });
		const currentHashes = new Map<string, ContentHash | null>([
			["a.ts", contentHashOf("a-after")],
			["b.ts", contentHashOf("someone-else-changed-it")],
		]);
		const plan = planMutationTransactionRevert([fresh, stale], currentHashes);
		expect(plan).toEqual({ safe: false, staleEntry: stale });
	});

	it("treats a path missing from currentHashes as nonexistent, matching a real deleted file", () => {
		const entryExpectingDeletion = entry({ path: "a.ts", afterHash: null });
		expect(planMutationTransactionRevert([entryExpectingDeletion], new Map())).toEqual({ safe: true });
	});

	it("approves an empty transaction trivially", () => {
		expect(planMutationTransactionRevert([], new Map())).toEqual({ safe: true });
	});
});
