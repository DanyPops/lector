import { describe, expect, it } from "bun:test";
import { truncateUtf8 } from "../../src/bounds/truncate-utf8.ts";

describe("truncateUtf8", () => {
	it("never splits a multibyte code point or exceeds the encoded byte bound", () => {
		const result = truncateUtf8("a😀b", 4);
		expect(result).toEqual({ value: "a", bytes: 1, truncated: true });
		expect(Buffer.byteLength(result.value, "utf8")).toBeLessThanOrEqual(4);
		expect(result.value).not.toContain("�");
	});

	it("preserves an already bounded value", () => {
		expect(truncateUtf8("a😀b", 6)).toEqual({ value: "a😀b", bytes: 6, truncated: false });
	});
});
