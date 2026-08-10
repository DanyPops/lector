import { describe, expect, it } from "bun:test";
import { paginateWithByteBudget } from "../../src/symbol-graph/paginate-cache-generation-detail.ts";

const BYTE_SIZE = (item: string) => item.length;

describe("paginateWithByteBudget", () => {
	it("returns everything untruncated when both bounds comfortably fit", () => {
		const result = paginateWithByteBudget(["a", "b", "c"], 0, 10, 1_000, BYTE_SIZE);
		expect(result).toEqual({ page: ["a", "b", "c"], totalCount: 3, truncated: false });
	});

	it("honors offset", () => {
		const result = paginateWithByteBudget(["a", "b", "c"], 1, 10, 1_000, BYTE_SIZE);
		expect(result).toEqual({ page: ["b", "c"], totalCount: 3, truncated: false });
	});

	it("truncates on maxResults and says so", () => {
		const result = paginateWithByteBudget(["a", "b", "c"], 0, 2, 1_000, BYTE_SIZE);
		expect(result).toEqual({ page: ["a", "b"], totalCount: 3, truncated: true });
	});

	it("truncates on maxBytes even under the maxResults cap", () => {
		const result = paginateWithByteBudget(["aaaa", "bbbb", "cccc"], 0, 10, 6, BYTE_SIZE);
		expect(result.page).toEqual(["aaaa"]);
		expect(result.truncated).toBe(true);
	});

	it("always includes at least one item even when that single item alone exceeds maxBytes -- a byte budget bounds growth, never starves a caller entirely", () => {
		const result = paginateWithByteBudget(["a-very-long-single-entry"], 0, 10, 1, BYTE_SIZE);
		expect(result.page).toEqual(["a-very-long-single-entry"]);
		expect(result.truncated).toBe(false);
	});

	it("reports totalCount against the full array, not just what offset left remaining", () => {
		const result = paginateWithByteBudget(["a", "b", "c", "d"], 2, 1, 1_000, BYTE_SIZE);
		expect(result.totalCount).toBe(4);
		expect(result.truncated).toBe(true);
	});

	it("rejects a negative offset", () => {
		expect(() => paginateWithByteBudget(["a"], -1, 10, 1_000, BYTE_SIZE)).toThrow(RangeError);
	});

	it("rejects a non-positive maxResults or maxBytes", () => {
		expect(() => paginateWithByteBudget(["a"], 0, 0, 1_000, BYTE_SIZE)).toThrow(RangeError);
		expect(() => paginateWithByteBudget(["a"], 0, 10, 0, BYTE_SIZE)).toThrow(RangeError);
	});

	it("returns an empty, untruncated page for an offset past the end", () => {
		const result = paginateWithByteBudget(["a", "b"], 5, 10, 1_000, BYTE_SIZE);
		expect(result).toEqual({ page: [], totalCount: 2, truncated: false });
	});
});
