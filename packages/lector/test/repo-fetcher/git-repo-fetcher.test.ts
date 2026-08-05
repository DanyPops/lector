/**
 * GitRepoFetcher against a real local git repository standing in for "the remote" --
 * resolveCloneUrl is the one injected seam (this is a real git clone underneath, not a mocked
 * git binary), so no network is touched, per this task's own no-live-network requirement.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureDirectorySizeBytes } from "../../src/adapters/directory-size.ts";
import { UnsafeGitArgument } from "../../src/git/assert-safe-git-argument.ts";
import { UnsafePathSegment } from "../../src/path-safety/assert-safe-path-segment.ts";
import { GitRepoFetcher } from "../../src/repo-fetcher/git-repo-fetcher.ts";
import { RepoFetchCapacityExceeded, RepoFetchFailed, RepoFetchLimitExceeded } from "../../src/repo-fetcher/repo-fetch-result.ts";
import type { RepoReference } from "../../src/repo-fetcher/repo-reference.ts";
import { requireDefined } from "../support/require-defined.ts";

let sourceRepo: string | undefined;
let reposDir: string | undefined;

afterEach(() => {
	if (sourceRepo) rmSync(sourceRepo, { recursive: true, force: true });
	if (reposDir) rmSync(reposDir, { recursive: true, force: true });
	sourceRepo = undefined;
	reposDir = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

/** A real local repo with two branches, standing in for a remote host/owner/repo. */
function buildSourceRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-repo-fetch-source-"));
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "README.md"), "on main\n");
	git(root, "add", "README.md");
	git(root, "commit", "-q", "-m", "main commit");
	git(root, "checkout", "-q", "-b", "feature");
	writeFileSync(join(root, "README.md"), "on feature\n");
	git(root, "commit", "-q", "-am", "feature commit");
	git(root, "checkout", "-q", "main");
	return root;
}

function reference(overrides: Partial<RepoReference> = {}): RepoReference {
	return { host: "local-fixture", owner: "acme", repo: "widgets", ref: null, ...overrides };
}

function buildFetcher(maxCacheBytes?: number): GitRepoFetcher {
	reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
	return new GitRepoFetcher(reposDir, {
		maxCacheBytes,
		resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo"),
	});
}

describe("GitRepoFetcher", () => {
	it("clones the default branch when no ref is given, and strips .git", async () => {
		sourceRepo = buildSourceRepo();
		const fetcher = buildFetcher();

		const result = await fetcher.fetch(reference());

		expect(result.fromCache).toBe(false);
		expect(result.resolvedRef).toBe("HEAD");
		expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(readFileSync(join(result.path, "README.md"), "utf8")).toBe("on main\n");
		expect(existsSync(join(result.path, ".git"))).toBe(false);
	});

	it("clones a specific ref's real content", async () => {
		sourceRepo = buildSourceRepo();
		const fetcher = buildFetcher();

		const result = await fetcher.fetch(reference({ ref: "feature" }));

		expect(result.resolvedRef).toBe("feature");
		expect(result.refFallbackOccurred).toBe(false);
		expect(readFileSync(join(result.path, "README.md"), "utf8")).toBe("on feature\n");
	});

	it("a second fetch of the same reference is served from cache, not re-cloned", async () => {
		sourceRepo = buildSourceRepo();
		const fetcher = buildFetcher();

		const first = await fetcher.fetch(reference());
		const second = await fetcher.fetch(reference());

		expect(first.fromCache).toBe(false);
		expect(second.fromCache).toBe(true);
		expect(second.path).toBe(first.path);
	});

	it("fetches an exact commit without assuming it is a branch or tag", async () => {
		sourceRepo = buildSourceRepo();
		const commit = execFileSync("git", ["rev-parse", "feature"], { cwd: sourceRepo, encoding: "utf8" }).trim();
		const fetcher = buildFetcher();

		const result = await fetcher.fetch(reference({ ref: commit }), { exactRef: true, timeoutMs: 10_000 });

		expect(result.commit).toBe(commit);
		expect(result.refFallbackOccurred).toBe(false);
		expect(readFileSync(join(result.path, "README.md"), "utf8")).toBe("on feature\n");
	});

	it("never falls back when the caller requires an exact ref", async () => {
		sourceRepo = buildSourceRepo();
		const fetcher = buildFetcher();

		await expect(fetcher.fetch(reference({ ref: "does-not-exist" }), { exactRef: true, timeoutMs: 10_000 })).rejects.toBeInstanceOf(RepoFetchFailed);
	});

	it("falls back to the default branch when the requested ref does not exist", async () => {
		sourceRepo = buildSourceRepo();
		const fetcher = buildFetcher();

		const result = await fetcher.fetch(reference({ ref: "does-not-exist" }));

		expect(result.refFallbackOccurred).toBe(true);
		expect(result.resolvedRef).toBe("HEAD");
		expect(readFileSync(join(result.path, "README.md"), "utf8")).toBe("on main\n");
	});

	it("throws RepoFetchFailed when even the default-branch fallback cannot clone", async () => {
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
		const fetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => "/no/such/path/at/all" });

		await expect(fetcher.fetch(reference())).rejects.toBeInstanceOf(RepoFetchFailed);
	});

	it("rejects a path-traversal owner before touching disk", async () => {
		sourceRepo = buildSourceRepo();
		const fetcher = buildFetcher();
		await expect(fetcher.fetch(reference({ owner: "../../etc" }))).rejects.toBeInstanceOf(UnsafePathSegment);
	});

	it("rejects a ref that looks like a git flag", async () => {
		sourceRepo = buildSourceRepo();
		const fetcher = buildFetcher();
		await expect(fetcher.fetch(reference({ ref: "--upload-pack=evil" }))).rejects.toBeInstanceOf(UnsafeGitArgument);
	});

	it("bounds queued fetches while one checkout is active", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
		const fetcher = new GitRepoFetcher(reposDir, { maxQueued: 0, resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });

		const active = fetcher.fetch(reference({ ref: "main" }));
		await expect(fetcher.fetch(reference({ ref: "feature" }))).rejects.toBeInstanceOf(RepoFetchCapacityExceeded);
		await active;
	});

	it("rejects and removes a checkout beyond the caller's clone or cache bound", async () => {
		sourceRepo = buildSourceRepo();
		const fetcher = buildFetcher();

		await expect(fetcher.fetch(reference({ ref: "main" }), { exactRef: true, maxCloneBytes: 1, maxCacheBytes: 1_000_000, timeoutMs: 10_000 })).rejects.toEqual(
			expect.objectContaining({ name: RepoFetchLimitExceeded.name, resource: "clone-bytes", limit: 1 }),
		);
		await expect(
			fetcher.fetch(reference({ ref: "feature" }), { exactRef: true, maxCloneBytes: 1_000_000, maxCacheBytes: 1, timeoutMs: 10_000 }),
		).rejects.toEqual(expect.objectContaining({ name: RepoFetchLimitExceeded.name, resource: "cache-bytes", limit: 1 }));
	});

	it("evicts the least-recently-fetched clone from disk once the disk budget is exceeded", async () => {
		sourceRepo = buildSourceRepo();

		// Measure one real clone's actual size first -- an arbitrary tiny budget like 1 byte would
		// reject every clone outright (nothing to evict, lru-cache just can't admit it), not
		// exercise real LRU eviction between two entries the way this test needs.
		const probe = buildFetcher();
		const probeResult = await probe.fetch(reference({ ref: "main" }));
		const oneCloneSize = await measureDirectorySizeBytes(probeResult.path);
		rmSync(requireDefined(reposDir, "reposDir"), { recursive: true, force: true });

		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
		const fetcher = new GitRepoFetcher(reposDir, {
			maxCacheBytes: Math.ceil(oneCloneSize * 1.5),
			resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo"),
		});

		const first = await fetcher.fetch(reference({ ref: "main" }));
		expect(existsSync(first.path)).toBe(true);

		const second = await fetcher.fetch(reference({ ref: "feature" }));
		expect(existsSync(second.path)).toBe(true);

		// The budget holds one clone but not two, so fetching the second reference must have
		// evicted the first -- its directory is gone from disk, not just from the index.
		expect(existsSync(first.path)).toBe(false);
	});

	it("persists across a fresh instance pointed at the same reposDir -- a real restart, not just a new in-process object", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));

		const first = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });
		const firstResult = await first.fetch(reference());

		const second = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });
		const secondResult = await second.fetch(reference());

		expect(secondResult.fromCache).toBe(true);
		expect(secondResult.path).toBe(firstResult.path);
	});

	describe("resolveRemoteCommit", () => {
		it("resolves a moving branch ref to the remote's real current commit, without cloning anything", async () => {
			sourceRepo = buildSourceRepo();
			reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
			const fetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });
			const expectedCommit = execFileSync("git", ["rev-parse", "main"], { cwd: sourceRepo }).toString().trim();

			const commit = await fetcher.resolveRemoteCommit(reference({ ref: "main" }));

			expect(commit).toBe(expectedCommit);
			expect(existsSync(join(reposDir, "local-fixture"))).toBe(false);
		});

		it("resolves null ref (default branch) the same way fetch() would resolve it", async () => {
			sourceRepo = buildSourceRepo();
			reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
			const fetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });
			const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRepo }).toString().trim();

			const commit = await fetcher.resolveRemoteCommit(reference());

			expect(commit).toBe(expectedCommit);
		});

		it("reflects a new commit pushed after the last fetch -- proves this is a live remote check, not a cached answer", async () => {
			sourceRepo = buildSourceRepo();
			reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
			const fetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });
			const before = await fetcher.resolveRemoteCommit(reference({ ref: "main" }));

			writeFileSync(join(sourceRepo, "README.md"), "on main, updated\n");
			git(sourceRepo, "commit", "-q", "-am", "a new main commit");
			const expectedAfter = execFileSync("git", ["rev-parse", "main"], { cwd: sourceRepo }).toString().trim();

			const after = await fetcher.resolveRemoteCommit(reference({ ref: "main" }));

			expect(after).not.toBe(before);
			expect(after).toBe(expectedAfter);
		});

		it("returns undefined, not a throw, for a ref that doesn't exist on the remote", async () => {
			sourceRepo = buildSourceRepo();
			reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
			const fetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });

			const commit = await fetcher.resolveRemoteCommit(reference({ ref: "no-such-branch" }));

			expect(commit).toBeUndefined();
		});

		it("returns undefined, not a throw, when the remote itself doesn't exist", async () => {
			reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
			const fetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => "/no/such/path/on/disk" });

			const commit = await fetcher.resolveRemoteCommit(reference());

			expect(commit).toBeUndefined();
		});

		it("returns undefined for an already-exact commit sha -- a sha can't move, so there's nothing to positively confirm as changed", async () => {
			sourceRepo = buildSourceRepo();
			reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
			const fetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });
			const sha = execFileSync("git", ["rev-parse", "main"], { cwd: sourceRepo }).toString().trim();

			const commit = await fetcher.resolveRemoteCommit(reference({ ref: sha }));

			expect(commit).toBeUndefined();
		});
	});

	describe("forceRefresh", () => {
		it("reclones a same-key reference in place and leaves a real, still-existing directory behind (regression: cache.set() previously disposed the freshly-renamed directory because the replaced entry's path was identical to the new one)", async () => {
			sourceRepo = buildSourceRepo();
			reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
			const fetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });

			const first = await fetcher.fetch(reference({ ref: "main" }));
			writeFileSync(join(sourceRepo, "README.md"), "on main, updated\n");
			git(sourceRepo, "commit", "-q", "-am", "a new main commit");

			const second = await fetcher.fetch(reference({ ref: "main" }), { forceRefresh: true });

			expect(second.path).toBe(first.path);
			expect(second.commit).not.toBe(first.commit);
			expect(existsSync(second.path)).toBe(true);
			expect(readFileSync(join(second.path, "README.md"), "utf8")).toBe("on main, updated\n");
		});

		it("ignores a still-fresh cache entry when forceRefresh is false, unlike the regression path above", async () => {
			sourceRepo = buildSourceRepo();
			reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
			const fetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });

			const first = await fetcher.fetch(reference({ ref: "main" }));
			const second = await fetcher.fetch(reference({ ref: "main" }));

			expect(second.fromCache).toBe(true);
			expect(second.commit).toBe(first.commit);
			expect(existsSync(second.path)).toBe(true);
		});
	});

	describe("listCached", () => {
		it("returns an empty list before anything has been fetched, not an error", async () => {
			const fetcher = buildFetcher();
			await expect(fetcher.listCached()).resolves.toEqual([]);
		});

		it("lists a fetched repository with its host/owner/repo parsed back out of the cache key, plus resolvedRef/commit/path/size", async () => {
			sourceRepo = buildSourceRepo();
			const fetcher = buildFetcher();
			const result = await fetcher.fetch(reference({ ref: null }));

			const listed = await fetcher.listCached();

			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({
				host: "local-fixture",
				owner: "acme",
				repo: "widgets",
				requestedRef: "HEAD",
				resolvedRef: result.resolvedRef,
				commit: result.commit,
				path: result.path,
			});
			expect(listed[0]?.cacheSizeBytes).toBeGreaterThan(0);
			expect(listed[0]?.fetchedAt).toBeGreaterThan(0);
		});

		it("correctly parses a requested ref that itself contains slashes, e.g. a branch named topic/foo", async () => {
			sourceRepo = buildSourceRepo();
			git(sourceRepo, "checkout", "-q", "-b", "topic/foo");
			const fetcher = buildFetcher();
			await fetcher.fetch(reference({ ref: "topic/foo" }), { exactRef: true });

			const listed = await fetcher.listCached();

			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({ host: "local-fixture", owner: "acme", repo: "widgets", requestedRef: "topic/foo" });
		});

		it("lists more than one distinct cached repository independently", async () => {
			sourceRepo = buildSourceRepo();
			const fetcher = buildFetcher();
			await fetcher.fetch(reference({ ref: "main" }));
			await fetcher.fetch({ host: "local-fixture", owner: "acme", repo: "other-widgets", ref: "main" });

			const listed = await fetcher.listCached();

			expect(listed.map((entry) => entry.repo).sort()).toEqual(["other-widgets", "widgets"]);
		});

		it("never touches the network or mutates cache state -- a second call returns byte-identical data", async () => {
			sourceRepo = buildSourceRepo();
			const fetcher = buildFetcher();
			await fetcher.fetch(reference({ ref: "main" }));

			const first = await fetcher.listCached();
			const second = await fetcher.listCached();

			expect(second).toEqual(first);
		});
	});

	describe("evict", () => {
		it("returns false and touches nothing for a reference that was never fetched", async () => {
			const fetcher = buildFetcher();
			await expect(fetcher.evict(reference())).resolves.toBe(false);
		});

		it("removes a fetched reference from the cache and deletes its checkout from disk", async () => {
			sourceRepo = buildSourceRepo();
			const fetcher = buildFetcher();
			const fetched = await fetcher.fetch(reference({ ref: "main" }));
			expect(existsSync(fetched.path)).toBe(true);

			const evicted = await fetcher.evict(reference({ ref: "main" }));

			expect(evicted).toBe(true);
			expect(existsSync(fetched.path)).toBe(false);
			await expect(fetcher.listCached()).resolves.toEqual([]);
		});

		it("only removes the exact reference asked for, leaving a different ref of the same repo cached", async () => {
			sourceRepo = buildSourceRepo();
			const fetcher = buildFetcher();
			await fetcher.fetch(reference({ ref: "main" }));
			await fetcher.fetch(reference({ ref: "feature" }));

			const evicted = await fetcher.evict(reference({ ref: "main" }));

			expect(evicted).toBe(true);
			const remaining = await fetcher.listCached();
			expect(remaining).toHaveLength(1);
			expect(remaining[0]).toMatchObject({ requestedRef: "feature" });
		});

		it("a fetch for the same reference after eviction reclones rather than silently reviving the evicted entry", async () => {
			sourceRepo = buildSourceRepo();
			const fetcher = buildFetcher();
			await fetcher.fetch(reference({ ref: "main" }));
			await fetcher.evict(reference({ ref: "main" }));

			const result = await fetcher.fetch(reference({ ref: "main" }));

			expect(result.fromCache).toBe(false);
			expect(existsSync(result.path)).toBe(true);
		});

		it("persists the eviction across a fresh instance pointed at the same reposDir, not just the in-memory cache", async () => {
			sourceRepo = buildSourceRepo();
			reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-cache-"));
			const first = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });
			await first.fetch(reference());
			await first.evict(reference());

			const second = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });

			await expect(second.listCached()).resolves.toEqual([]);
		});
	});
});
