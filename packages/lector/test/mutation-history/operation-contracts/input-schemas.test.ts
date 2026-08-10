/** Each schema's safeParse success/failure branches, without spinning up a registry or workspace. */
import { describe, expect, it } from "bun:test";
import { mutationHistoryInputSchema, revertMutationInputSchema } from "../../../src/mutation-history/input-schemas.ts";

describe("mutationHistoryInputSchema", () => {
	it("accepts workspaceId/path/maxResults, maxBytes omitted", () => {
		expect(mutationHistoryInputSchema.safeParse({ workspaceId: "ws", path: "a.ts", maxResults: 10 })).toEqual({
			success: true,
			value: { workspaceId: "ws", path: "a.ts", maxResults: 10, maxBytes: undefined },
		});
	});

	it("accepts an explicit maxBytes", () => {
		expect(mutationHistoryInputSchema.safeParse({ workspaceId: "ws", path: "a.ts", maxResults: 10, maxBytes: 1000 })).toEqual({
			success: true,
			value: { workspaceId: "ws", path: "a.ts", maxResults: 10, maxBytes: 1000 },
		});
	});

	it("rejects a non-object", () => {
		expect(mutationHistoryInputSchema.safeParse("nope").success).toBe(false);
	});

	it("rejects a missing maxResults", () => {
		const result = mutationHistoryInputSchema.safeParse({ workspaceId: "ws", path: "a.ts" });
		expect(result).toEqual({ success: false, issues: [{ path: ["maxResults"], message: "maxResults must be a positive safe integer" }] });
	});

	it("rejects a non-numeric maxBytes", () => {
		const result = mutationHistoryInputSchema.safeParse({ workspaceId: "ws", path: "a.ts", maxResults: 10, maxBytes: "big" });
		expect(result).toEqual({ success: false, issues: [{ path: ["maxBytes"], message: "maxBytes must be a positive safe integer when given" }] });
	});

	it("rejects an empty path", () => {
		const result = mutationHistoryInputSchema.safeParse({ workspaceId: "ws", path: "", maxResults: 10 });
		expect(result).toEqual({ success: false, issues: [{ path: ["path"], message: "path must be a non-empty string" }] });
	});
});

describe("revertMutationInputSchema", () => {
	it("accepts a valid workspaceId and entryId", () => {
		expect(revertMutationInputSchema.safeParse({ workspaceId: "ws", entryId: "e1" })).toEqual({ success: true, value: { workspaceId: "ws", entryId: "e1" } });
	});

	it("rejects a missing entryId", () => {
		const result = revertMutationInputSchema.safeParse({ workspaceId: "ws" });
		expect(result).toEqual({ success: false, issues: [{ path: ["entryId"], message: "entryId must be a non-empty string" }] });
	});
});
