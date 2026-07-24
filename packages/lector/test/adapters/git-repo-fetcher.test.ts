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
import { GitRepoFetcher } from "../../src/adapters/git-repo-fetcher.ts";
import { UnsafeGitArgument } from "../../src/domain/assert-safe-git-argument.ts";
import { UnsafePathSegment } from "../../src/domain/assert-safe-path-segment.ts";
import { RepoFetchFailed } from "../../src/domain/repo-fetch-result.ts";
import type { RepoReference } from "../../src/domain/repo-reference.ts";
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
});
