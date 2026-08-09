/** Each schema's safeParse success/failure branches, without spinning up a registry or workspace. */
import { describe, expect, it } from "bun:test";
import { repoEvictCacheInputSchema, repoFetchInputSchema, repoListCacheInputSchema } from "../../../src/repo-fetcher/input-schemas.ts";

describe("repoFetchInputSchema", () => {
	it("accepts a full reference with ref: null and forceRefresh omitted", () => {
		expect(repoFetchInputSchema.safeParse({ host: "github.com", owner: "a", repo: "b", ref: null })).toEqual({
			success: true,
			value: { host: "github.com", owner: "a", repo: "b", ref: null, forceRefresh: undefined },
		});
	});

	it("accepts an explicit ref string and forceRefresh", () => {
		expect(repoFetchInputSchema.safeParse({ host: "github.com", owner: "a", repo: "b", ref: "main", forceRefresh: true })).toEqual({
			success: true,
			value: { host: "github.com", owner: "a", repo: "b", ref: "main", forceRefresh: true },
		});
	});

	it("rejects a missing ref -- null must be explicit, not merely omitted", () => {
		expect(repoFetchInputSchema.safeParse({ host: "github.com", owner: "a", repo: "b" })).toEqual({
			success: false,
			issues: [{ path: ["ref"], message: "ref is required (use null for the remote's default branch)" }],
		});
	});

	it("rejects an empty owner", () => {
		const result = repoFetchInputSchema.safeParse({ host: "github.com", owner: "", repo: "b", ref: null });
		expect(result).toEqual({ success: false, issues: [{ path: ["owner"], message: "owner must be a non-empty string" }] });
	});

	it("rejects a non-boolean forceRefresh", () => {
		const result = repoFetchInputSchema.safeParse({ host: "github.com", owner: "a", repo: "b", ref: null, forceRefresh: "yes" });
		expect(result).toEqual({ success: false, issues: [{ path: ["forceRefresh"], message: "forceRefresh must be a boolean when given" }] });
	});
});

describe("repoEvictCacheInputSchema", () => {
	it("accepts a full reference", () => {
		expect(repoEvictCacheInputSchema.safeParse({ host: "github.com", owner: "a", repo: "b", ref: "main" })).toEqual({
			success: true,
			value: { host: "github.com", owner: "a", repo: "b", ref: "main" },
		});
	});

	it("rejects a non-string, non-null ref", () => {
		const result = repoEvictCacheInputSchema.safeParse({ host: "github.com", owner: "a", repo: "b", ref: 1 });
		expect(result).toEqual({ success: false, issues: [{ path: ["ref"], message: "ref must be a string or null" }] });
	});
});

describe("repoListCacheInputSchema", () => {
	it("accepts just maxResults -- every filter field is optional", () => {
		expect(repoListCacheInputSchema.safeParse({ maxResults: 10 })).toEqual({
			success: true,
			value: { text: undefined, host: undefined, owner: undefined, repo: undefined, ref: undefined, maxResults: 10, cursor: undefined },
		});
	});

	it("accepts every optional filter field alongside maxResults", () => {
		const input = { text: "t", host: "h", owner: "o", repo: "r", ref: "main", maxResults: 5, cursor: "c" };
		expect(repoListCacheInputSchema.safeParse(input)).toEqual({ success: true, value: input });
	});

	it("rejects a missing maxResults", () => {
		const result = repoListCacheInputSchema.safeParse({});
		expect(result).toEqual({ success: false, issues: [{ path: ["maxResults"], message: "maxResults must be a positive safe integer" }] });
	});

	it("rejects a non-string text filter", () => {
		const result = repoListCacheInputSchema.safeParse({ maxResults: 5, text: 42 });
		expect(result).toEqual({ success: false, issues: [{ path: ["text"], message: "text must be a string when given" }] });
	});
});
