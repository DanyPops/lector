import { describe, expect, it } from "bun:test";
import { boundList, boundListFromStart, jsonByteSize } from "../../src/bounds/bound-list.ts";

const BYTE_SIZE = (item: string) => item.length;

describe("boundList", () => {
	it("returns everything untruncated when both bounds comfortably fit", () => {
		const result = boundList(["a", "b", "c"], 0, 10, 1_000, BYTE_SIZE);
		expect(result).toEqual({ page: ["a", "b", "c"], totalCount: 3, truncated: false });
	});

	it("honors offset", () => {
		const result = boundList(["a", "b", "c"], 1, 10, 1_000, BYTE_SIZE);
		expect(result).toEqual({ page: ["b", "c"], totalCount: 3, truncated: false });
	});

	it("truncates on maxResults and says so", () => {
		const result = boundList(["a", "b", "c"], 0, 2, 1_000, BYTE_SIZE);
		expect(result).toEqual({ page: ["a", "b"], totalCount: 3, truncated: true });
	});

	it("truncates on maxBytes even under the maxResults cap", () => {
		const result = boundList(["aaaa", "bbbb", "cccc"], 0, 10, 6, BYTE_SIZE);
		expect(result.page).toEqual(["aaaa"]);
		expect(result.truncated).toBe(true);
	});

	it("always includes at least one item even when that single item alone exceeds maxBytes -- a byte budget bounds growth, never starves a caller entirely", () => {
		const result = boundList(["a-very-long-single-entry"], 0, 10, 1, BYTE_SIZE);
		expect(result.page).toEqual(["a-very-long-single-entry"]);
		expect(result.truncated).toBe(false);
	});

	it("reports totalCount against the full array, not just what offset left remaining", () => {
		const result = boundList(["a", "b", "c", "d"], 2, 1, 1_000, BYTE_SIZE);
		expect(result.totalCount).toBe(4);
		expect(result.truncated).toBe(true);
	});

	it("rejects a negative offset", () => {
		expect(() => boundList(["a"], -1, 10, 1_000, BYTE_SIZE)).toThrow(RangeError);
	});

	it("rejects a non-positive maxResults or maxBytes", () => {
		expect(() => boundList(["a"], 0, 0, 1_000, BYTE_SIZE)).toThrow(RangeError);
		expect(() => boundList(["a"], 0, 10, 0, BYTE_SIZE)).toThrow(RangeError);
	});

	it("returns an empty, untruncated page for an offset past the end", () => {
		const result = boundList(["a", "b"], 5, 10, 1_000, BYTE_SIZE);
		expect(result).toEqual({ page: [], totalCount: 2, truncated: false });
	});
});

describe("boundListFromStart", () => {
	it("is boundList with offset fixed at 0", () => {
		expect(boundListFromStart(["a", "b", "c"], 2, 1_000, BYTE_SIZE)).toEqual(boundList(["a", "b", "c"], 0, 2, 1_000, BYTE_SIZE));
	});
});

describe("jsonByteSize", () => {
	it("returns the exact UTF-8 byte size of the JSON encoding, not a character count", () => {
		expect(jsonByteSize("a")).toBe(3); // `"a"` -- two quote bytes plus the character
		expect(jsonByteSize("\u00e9")).toBe(4); // "é" is 1 UTF-16 char but 2 UTF-8 bytes, plus two quote bytes
	});

	it("sizes an object the same way JSON.stringify would encode it", () => {
		const item = { path: "/repo/a.ts", line: 1, character: 2 };
		expect(jsonByteSize(item)).toBe(Buffer.byteLength(JSON.stringify(item), "utf8"));
	});
});
