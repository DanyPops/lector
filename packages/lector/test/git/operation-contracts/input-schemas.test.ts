/** Each schema's safeParse success/failure branches, without spinning up a registry or workspace. */
import { describe, expect, it } from "bun:test";
import {
	gitDiffInputSchema,
	gitGrepHistoryInputSchema,
	gitGrepInputSchema,
	gitIsAncestorInputSchema,
	gitListFilesInputSchema,
	gitLogInputSchema,
	gitShowFileInputSchema,
	gitStatusInputSchema,
} from "../../../src/git/input-schemas.ts";

describe("Git input schemas", () => {
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

	describe("gitShowFileInputSchema", () => {
		it("accepts a valid workspaceId, ref, and path", () => {
			expect(gitShowFileInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD", path: "a.txt" })).toEqual({
				success: true,
				value: { workspaceId: "ws", ref: "HEAD", path: "a.txt" },
			});
		});

		it("rejects a missing ref", () => {
			const result = gitShowFileInputSchema.safeParse({ workspaceId: "ws", path: "a.txt" });
			expect(result).toEqual({ success: false, issues: [{ path: ["ref"], message: "ref must be a non-empty string" }] });
		});

		it("rejects a missing path", () => {
			const result = gitShowFileInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD" });
			expect(result).toEqual({ success: false, issues: [{ path: ["path"], message: "path must be a non-empty string" }] });
		});
	});

	describe("gitGrepInputSchema", () => {
		it("accepts a valid request without pathspecs", () => {
			expect(gitGrepInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD", pattern: "foo", maxMatches: 10, maxBytes: 1000 })).toEqual({
				success: true,
				value: { workspaceId: "ws", ref: "HEAD", pattern: "foo", pathspecs: undefined, maxMatches: 10, maxBytes: 1000 },
			});
		});

		it("accepts an explicit pathspecs array", () => {
			const result = gitGrepInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD", pattern: "foo", pathspecs: ["*.go"], maxMatches: 10, maxBytes: 1000 });
			expect(result).toEqual({
				success: true,
				value: { workspaceId: "ws", ref: "HEAD", pattern: "foo", pathspecs: ["*.go"], maxMatches: 10, maxBytes: 1000 },
			});
		});

		it("rejects a non-array pathspecs", () => {
			const result = gitGrepInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD", pattern: "foo", pathspecs: "*.go", maxMatches: 10, maxBytes: 1000 });
			expect(result).toEqual({ success: false, issues: [{ path: ["pathspecs"], message: "pathspecs must be an array of strings when given" }] });
		});

		it("rejects a missing pattern", () => {
			const result = gitGrepInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD", maxMatches: 10, maxBytes: 1000 });
			expect(result).toEqual({ success: false, issues: [{ path: ["pattern"], message: "pattern must be a non-empty string" }] });
		});

		it("rejects a missing maxMatches", () => {
			const result = gitGrepInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD", pattern: "foo", maxBytes: 1000 });
			expect(result).toEqual({ success: false, issues: [{ path: ["maxMatches"], message: "maxMatches must be a positive safe integer" }] });
		});
	});

	describe("gitGrepHistoryInputSchema", () => {
		const valid = {
			workspaceId: "ws",
			pattern: "foo.*bar",
			commitOffset: 0,
			maxCommits: 100,
			maxMatches: 50,
			maxBytes: 100_000,
			deadlineMs: 5_000,
		};

		it("accepts an explicitly bounded history search", () => {
			expect(gitGrepHistoryInputSchema.safeParse(valid)).toEqual({ success: true, value: { ...valid, pathspecs: undefined } });
		});

		it("accepts bounded pathspecs", () => {
			expect(gitGrepHistoryInputSchema.safeParse({ ...valid, pathspecs: ["src/*.ts"] })).toEqual({
				success: true,
				value: { ...valid, pathspecs: ["src/*.ts"] },
			});
		});

		it("rejects absent or excessive resource bounds", () => {
			expect(gitGrepHistoryInputSchema.safeParse({ ...valid, maxCommits: undefined }).success).toBe(false);
			expect(gitGrepHistoryInputSchema.safeParse({ ...valid, maxCommits: 513 }).success).toBe(false);
			expect(gitGrepHistoryInputSchema.safeParse({ ...valid, maxMatches: 10_001 }).success).toBe(false);
			expect(gitGrepHistoryInputSchema.safeParse({ ...valid, maxBytes: 8 * 1024 * 1024 + 1 }).success).toBe(false);
			expect(gitGrepHistoryInputSchema.safeParse({ ...valid, deadlineMs: 120_001 }).success).toBe(false);
		});

		it("rejects an unbounded pathspec collection and oversized pattern", () => {
			expect(gitGrepHistoryInputSchema.safeParse({ ...valid, pathspecs: Array.from({ length: 65 }, () => "*.ts") }).success).toBe(false);
			expect(gitGrepHistoryInputSchema.safeParse({ ...valid, pattern: "x".repeat(4_097) }).success).toBe(false);
		});
	});

	describe("gitListFilesInputSchema", () => {
		it("accepts a valid request without pathspecs", () => {
			expect(gitListFilesInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD", maxResults: 100 })).toEqual({
				success: true,
				value: { workspaceId: "ws", ref: "HEAD", pathspecs: undefined, maxResults: 100 },
			});
		});

		it("rejects a non-array pathspecs", () => {
			const result = gitListFilesInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD", pathspecs: 42, maxResults: 100 });
			expect(result).toEqual({ success: false, issues: [{ path: ["pathspecs"], message: "pathspecs must be an array of strings when given" }] });
		});

		it("rejects a missing maxResults", () => {
			const result = gitListFilesInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD" });
			expect(result).toEqual({ success: false, issues: [{ path: ["maxResults"], message: "maxResults must be a positive safe integer" }] });
		});
	});

	describe("gitIsAncestorInputSchema", () => {
		it("accepts a valid request", () => {
			expect(gitIsAncestorInputSchema.safeParse({ workspaceId: "ws", ancestorRef: "HEAD~1", ref: "HEAD" })).toEqual({
				success: true,
				value: { workspaceId: "ws", ancestorRef: "HEAD~1", ref: "HEAD" },
			});
		});

		it("rejects a missing ancestorRef", () => {
			const result = gitIsAncestorInputSchema.safeParse({ workspaceId: "ws", ref: "HEAD" });
			expect(result).toEqual({ success: false, issues: [{ path: ["ancestorRef"], message: "ancestorRef must be a non-empty string" }] });
		});

		it("rejects a missing ref", () => {
			const result = gitIsAncestorInputSchema.safeParse({ workspaceId: "ws", ancestorRef: "HEAD~1" });
			expect(result).toEqual({ success: false, issues: [{ path: ["ref"], message: "ref must be a non-empty string" }] });
		});
	});
});
