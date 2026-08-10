/** Shared conformance suite for any MutationHistoryPort implementation. */
import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import type { MutationHistoryPort } from "../../src/mutation-history/port.ts";

export interface MutationHistoryConformanceHarness {
	/** A fresh store; maxEntriesPerFile lets a test exercise eviction deterministically. */
	createStore(maxEntriesPerFile?: number): MutationHistoryPort | Promise<MutationHistoryPort>;
}

export function runMutationHistoryPortConformanceSuite(name: string, harness: MutationHistoryConformanceHarness): void {
	describe(`MutationHistoryPort conformance: ${name}`, () => {
		it("records an entry and serves it back by id", async () => {
			const store = await harness.createStore();
			const recorded = await store.record({
				path: "a.ts",
				operation: "exactEdit",
				beforeContent: "before",
				beforeHash: contentHashOf("before"),
				afterHash: contentHashOf("after"),
				transactionId: null,
			});

			expect(recorded.path).toBe("a.ts");
			expect(recorded.operation).toBe("exactEdit");
			await expect(store.get(recorded.id)).resolves.toEqual(recorded);
		});

		it("returns undefined for an id that was never recorded, not an error", async () => {
			const store = await harness.createStore();
			await expect(store.get("never-recorded")).resolves.toBeUndefined();
		});

		it("lists a path's entries newest first", async () => {
			const store = await harness.createStore();
			const first = await store.record({
				path: "a.ts",
				operation: "exactEdit",
				beforeContent: null,
				beforeHash: null,
				afterHash: contentHashOf("v1"),
				transactionId: null,
			});
			const second = await store.record({
				path: "a.ts",
				operation: "lineEdit",
				beforeContent: "v1",
				beforeHash: contentHashOf("v1"),
				afterHash: contentHashOf("v2"),
				transactionId: null,
			});

			const entries = await store.listForPath("a.ts", 10);
			expect(entries.map((entry) => entry.id)).toEqual([second.id, first.id]);
		});

		it("never mixes one path's history into another path's list", async () => {
			const store = await harness.createStore();
			await store.record({ path: "a.ts", operation: "exactEdit", beforeContent: null, beforeHash: null, afterHash: contentHashOf("a"), transactionId: null });
			await store.record({ path: "b.ts", operation: "exactEdit", beforeContent: null, beforeHash: null, afterHash: contentHashOf("b"), transactionId: null });

			const entries = await store.listForPath("a.ts", 10);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.path).toBe("a.ts");
		});

		it("returns an empty list for a path with no recorded history, not an error", async () => {
			const store = await harness.createStore();
			await expect(store.listForPath("never-touched.ts", 10)).resolves.toEqual([]);
		});

		it("bounds a single listForPath call by maxResults", async () => {
			const store = await harness.createStore();
			for (let index = 0; index < 5; index++) {
				await store.record({
					path: "a.ts",
					operation: "exactEdit",
					beforeContent: null,
					beforeHash: null,
					afterHash: contentHashOf(`v${index}`),
					transactionId: null,
				});
			}
			const entries = await store.listForPath("a.ts", 2);
			expect(entries).toHaveLength(2);
		});

		it("evicts the OLDEST entry for a path once maxEntriesPerFile is exceeded, never a newer one", async () => {
			const store = await harness.createStore(2);
			const first = await store.record({
				path: "a.ts",
				operation: "exactEdit",
				beforeContent: null,
				beforeHash: null,
				afterHash: contentHashOf("v0"),
				transactionId: null,
			});
			const second = await store.record({
				path: "a.ts",
				operation: "exactEdit",
				beforeContent: "v0",
				beforeHash: contentHashOf("v0"),
				afterHash: contentHashOf("v1"),
				transactionId: null,
			});
			const third = await store.record({
				path: "a.ts",
				operation: "exactEdit",
				beforeContent: "v1",
				beforeHash: contentHashOf("v1"),
				afterHash: contentHashOf("v2"),
				transactionId: null,
			});

			const entries = await store.listForPath("a.ts", 10);
			expect(entries.map((entry) => entry.id)).toEqual([third.id, second.id]);
			await expect(store.get(first.id)).resolves.toBeUndefined();
		});

		it("lists every entry recorded under one transaction, across paths, in recorded order", async () => {
			const store = await harness.createStore();
			const first = await store.record({
				path: "a.ts",
				operation: "rename",
				beforeContent: "a-content",
				beforeHash: contentHashOf("a-content"),
				afterHash: null,
				transactionId: "tx-1",
			});
			const second = await store.record({
				path: "b.ts",
				operation: "rename",
				beforeContent: null,
				beforeHash: null,
				afterHash: contentHashOf("a-content"),
				transactionId: "tx-1",
			});
			// An unrelated single-file write recorded in between must never leak into the transaction's own list.
			await store.record({ path: "c.ts", operation: "exactEdit", beforeContent: null, beforeHash: null, afterHash: contentHashOf("c"), transactionId: null });

			const entries = await store.listByTransaction("tx-1");
			expect(entries.map((entry) => entry.id)).toEqual([first.id, second.id]);
		});

		it("returns an empty list for a transaction id that was never recorded, not an error", async () => {
			const store = await harness.createStore();
			await expect(store.listByTransaction("never-recorded")).resolves.toEqual([]);
		});
	});
}
