/** Each schema's safeParse success/failure branches, without spinning up a registry or workspace. */
import { describe, expect, it } from "bun:test";
import { gitDiffInputSchema, gitLogInputSchema, gitStatusInputSchema } from "../../../src/service/vehicle/git-schemas.ts";

describe("git-schemas.ts", () => {
	describe("gitStatusInputSchema", () => {
		it("accepts a valid workspaceId", () => {
			expect(gitStatusInputSchema.safeParse({ workspaceId: "ws" })).toEqual({ success: true, value: { workspaceId: "ws" } });
		});

		it("rejects a non-object", () => {
			expect(gitStatusInputSchema.safeParse("nope").success).toBe(false);
		});

		it("rejects a missing/empty workspaceId", () => {
			const result = gitStatusInputSchema.safeParse({});
			expect(result).toEqual({ success: false, issues: [{ path: ["workspaceId"], message: "workspaceId must be a non-empty string" }] });
		});
	});

	describe("gitLogInputSchema", () => {
		it("accepts a valid workspaceId and maxCount", () => {
			expect(gitLogInputSchema.safeParse({ workspaceId: "ws", maxCount: 10 })).toEqual({ success: true, value: { workspaceId: "ws", maxCount: 10 } });
		});

		it("rejects a non-numeric maxCount", () => {
			const result = gitLogInputSchema.safeParse({ workspaceId: "ws", maxCount: "10" });
			expect(result).toEqual({ success: false, issues: [{ path: ["maxCount"], message: "maxCount must be a positive safe integer" }] });
		});

		it("rejects a zero or negative maxCount", () => {
			expect(gitLogInputSchema.safeParse({ workspaceId: "ws", maxCount: 0 }).success).toBe(false);
			expect(gitLogInputSchema.safeParse({ workspaceId: "ws", maxCount: -1 }).success).toBe(false);
		});
	});

	describe("gitDiffInputSchema", () => {
		it("accepts a valid workspaceId and maxBytes, ref omitted", () => {
			expect(gitDiffInputSchema.safeParse({ workspaceId: "ws", maxBytes: 100 })).toEqual({
				success: true,
				value: { workspaceId: "ws", ref: undefined, maxBytes: 100 },
			});
		});

		it("accepts an explicit string ref", () => {
			expect(gitDiffInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD~1", maxBytes: 100 })).toEqual({
				success: true,
				value: { workspaceId: "ws", ref: "HEAD~1", maxBytes: 100 },
			});
		});

		it("rejects a non-string ref", () => {
			const result = gitDiffInputSchema.safeParse({ workspaceId: "ws", ref: 42, maxBytes: 100 });
			expect(result).toEqual({ success: false, issues: [{ path: ["ref"], message: "ref must be a string when given" }] });
		});

		it("rejects a missing maxBytes", () => {
			const result = gitDiffInputSchema.safeParse({ workspaceId: "ws" });
			expect(result).toEqual({ success: false, issues: [{ path: ["maxBytes"], message: "maxBytes must be a positive safe integer" }] });
		});
	});
});
