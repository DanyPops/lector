import { describe, expect, it } from "bun:test";
import { contentHashOf, type MutationHistoryEntry } from "@danypops/lector";
import { formatMutationHistoryList, formatMutationTransactionRevert } from "../../extension/src/mutation-history/rendering.ts";

function entry(overrides: Partial<MutationHistoryEntry> = {}): MutationHistoryEntry {
	return {
		id: "entry-1",
		path: "src/a.ts",
		operation: "exactEdit",
		beforeContent: "before",
		beforeHash: contentHashOf("before"),
		afterHash: contentHashOf("after"),
		transactionId: null,
		timestamp: 0,
		...overrides,
	};
}

describe("mutation history rendering", () => {
	it("surfaces transaction ids in list output while distinguishing standalone entries", () => {
		const text = formatMutationHistoryList([entry({ id: "standalone" }), entry({ id: "member", transactionId: "tx-1", operation: "rename" })]);
		expect(text).toContain("standalone");
		expect(text).toContain("standalone mutation");
		expect(text).toContain("member");
		expect(text).toContain("transaction tx-1");
	});

	it("reports every atomically reverted path and names the further-revertible transaction", () => {
		const text = formatMutationTransactionRevert("tx-old", {
			transactionId: "tx-revert",
			reverted: [
				{ path: "src/a.ts", newHash: "hash-a" },
				{ path: "src/b.ts", newHash: null },
			],
		});
		expect(text).toContain("tx-old reverted atomically");
		expect(text).toContain("recorded as transaction tx-revert");
		expect(text).toContain("src/a.ts -> hash-a");
		expect(text).toContain("src/b.ts -> (deleted)");
	});
});
