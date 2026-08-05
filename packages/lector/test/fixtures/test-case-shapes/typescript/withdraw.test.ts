/**
 * Distilled from real-world Jest/Bun idioms (e.g. carloscuesta/gitmoji-cli's
 * describe/test.each usage): a nested describe/it suite plus a parameterized
 * test.each block -- the shape a test-case symbol extractor has to handle,
 * not just a single top-level it().
 */
import { describe, expect, it, test } from "bun:test";
import { withdraw } from "./withdraw.ts";

describe("withdraw", () => {
	it("rejects a withdrawal larger than the balance", () => {
		expect(() => withdraw({ balance: 10 }, 20)).toThrow("insufficient funds");
	});

	it("debits the account by exactly the requested amount", () => {
		expect(withdraw({ balance: 10 }, 4).balance).toBe(6);
	});

	test.each([
		[0, 10],
		[-1, 10],
	])("rejects a non-positive withdrawal amount %p against balance %p", (amount, balance) => {
		expect(() => withdraw({ balance }, amount)).toThrow("invalid amount");
	});
});
