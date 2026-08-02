import { describe, expect, it } from "bun:test";
import type { CachedRepositoryEntry } from "../../src/repo-fetcher/cached-repository-entry.ts";
import { queryCachedRepositories } from "../../src/repo-fetcher/cached-repository-entry.ts";

function entry(overrides: Partial<CachedRepositoryEntry> = {}): CachedRepositoryEntry {
	return {
		host: "github.com",
		owner: "sourcegraph",
		repo: "zoekt",
		requestedRef: "HEAD",
		resolvedRef: "main",
		commit: "a".repeat(40),
		path: "/cache/github.com/sourcegraph/zoekt/HEAD",
		cacheSizeBytes: 1024,
		fetchedAt: 1000,
		registeredWorkspaceId: null,
		...overrides,
	};
}

describe("queryCachedRepositories", () => {
	it("returns every entry, sorted deterministically by canonical identity, when given no filter", () => {
		const b = entry({ owner: "b-owner", repo: "b-repo" });
		const a = entry({ owner: "a-owner", repo: "a-repo" });
		const page = queryCachedRepositories([b, a], {}, 10);
		expect(page.entries.map((e) => e.owner)).toEqual(["a-owner", "b-owner"]);
		expect(page.nextCursor).toBeNull();
	});

	it("filters by exact host", () => {
		const github = entry({ host: "github.com" });
		const gitlab = entry({ host: "gitlab.com", owner: "other" });
		const page = queryCachedRepositories([github, gitlab], { host: "gitlab.com" }, 10);
		expect(page.entries).toEqual([gitlab]);
	});

	it("filters by exact owner", () => {
		const one = entry({ owner: "alice" });
		const two = entry({ owner: "bob", repo: "other-repo" });
		const page = queryCachedRepositories([one, two], { owner: "bob" }, 10);
		expect(page.entries).toEqual([two]);
	});

	it("filters by exact repo", () => {
		const one = entry({ repo: "zoekt" });
		const two = entry({ repo: "sourcegraph", owner: "other" });
		const page = queryCachedRepositories([one, two], { repo: "sourcegraph" }, 10);
		expect(page.entries).toEqual([two]);
	});

	it("filters by ref matching either requestedRef or resolvedRef", () => {
		const requested = entry({ requestedRef: "v1.0.0", resolvedRef: "v1.0.0" });
		const resolved = entry({ owner: "other", requestedRef: "HEAD", resolvedRef: "main" });
		const page = queryCachedRepositories([requested, resolved], { ref: "main" }, 10);
		expect(page.entries).toEqual([resolved]);
	});

	it("filters by case-insensitive text substring across host/owner/repo/refs", () => {
		const match = entry({ owner: "SourceGraph" });
		const noMatch = entry({ owner: "other", repo: "unrelated" });
		const page = queryCachedRepositories([match, noMatch], { text: "sourcegraph" }, 10);
		expect(page.entries).toEqual([match]);
	});

	it("combines multiple filters as an AND, not an OR", () => {
		const both = entry({ host: "github.com", owner: "match" });
		const hostOnly = entry({ host: "github.com", owner: "other" });
		const ownerOnly = entry({ host: "gitlab.com", owner: "match", repo: "other-repo" });
		const page = queryCachedRepositories([both, hostOnly, ownerOnly], { host: "github.com", owner: "match" }, 10);
		expect(page.entries).toEqual([both]);
	});

	it("bounds the page to maxResults and returns a non-null cursor when more entries remain", () => {
		const entries = [entry({ owner: "a" }), entry({ owner: "b" }), entry({ owner: "c" })];
		const page = queryCachedRepositories(entries, {}, 2);
		expect(page.entries.map((e) => e.owner)).toEqual(["a", "b"]);
		expect(page.nextCursor).not.toBeNull();
	});

	it("resumes correctly from a cursor returned by a prior page, without skipping or repeating entries", () => {
		const entries = [entry({ owner: "a" }), entry({ owner: "b" }), entry({ owner: "c" })];
		const first = queryCachedRepositories(entries, {}, 2);
		const second = queryCachedRepositories(entries, {}, 2, first.nextCursor ?? undefined);
		expect(second.entries.map((e) => e.owner)).toEqual(["c"]);
		expect(second.nextCursor).toBeNull();
	});

	it("returns an empty page, not an error, when the cache is empty", () => {
		const page = queryCachedRepositories([], {}, 10);
		expect(page.entries).toEqual([]);
		expect(page.nextCursor).toBeNull();
	});

	it("returns an empty page when the cursor is past the end of the (possibly filtered) result set", () => {
		const entries = [entry({ owner: "a" })];
		const first = queryCachedRepositories(entries, {}, 10);
		expect(first.nextCursor).toBeNull();
		const second = queryCachedRepositories(entries, {}, 10, "zzz-not-a-real-cursor");
		expect(second.entries).toEqual([]);
	});

	it("rejects a non-positive maxResults -- every bounded query requires an explicit, real limit", () => {
		expect(() => queryCachedRepositories([], {}, 0)).toThrow();
		expect(() => queryCachedRepositories([], {}, -1)).toThrow();
	});
});
