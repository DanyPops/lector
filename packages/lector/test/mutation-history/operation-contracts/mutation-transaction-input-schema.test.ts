/** Each schema's safeParse success/failure branches, without spinning up a registry or workspace. */
import { describe, expect, it } from "bun:test";
import { mutationTransactionInputSchema } from "../../../src/mutation-history/input-schemas.ts";

describe("mutationTransactionInputSchema", () => {
	it("accepts a valid workspaceId and transactionId", () => {
		expect(mutationTransactionInputSchema.safeParse({ workspaceId: "ws", transactionId: "tx-1" })).toEqual({
			success: true,
			value: { workspaceId: "ws", transactionId: "tx-1" },
		});
	});

	it("rejects a missing transactionId", () => {
		const result = mutationTransactionInputSchema.safeParse({ workspaceId: "ws" });
		expect(result).toEqual({ success: false, issues: [{ path: ["transactionId"], message: "transactionId must be a non-empty string" }] });
	});

	it("rejects a non-object", () => {
		expect(mutationTransactionInputSchema.safeParse(42).success).toBe(false);
	});
});
