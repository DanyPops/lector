/**
 * Service-level wiring for repo.fetch: a real GitRepoFetcher clone lands in the same
 * workspace registry every other operation reads from -- rawRead sees it, writeEntry
 * rejects it. Real GitRepoFetcher correctness (eviction, ref fallback, atomicity) is
 * already covered directly in test/repo-fetcher/git-repo-fetcher.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepoFetcher } from "../src/repo-fetcher/git-repo-fetcher.ts";
import type { RepoReference } from "../src/repo-fetcher/repo-reference.ts";
import { createLectorService, type LectorService, RepoCacheEntryInUse, RepoFetcherNotConfigured } from "../src/service.ts";
import { WorkspaceIsReadOnly } from "../src/workspace/read-only-workspace.ts";
import { recordingLogger } from "./support/recording-logger.ts";
import { requireDefined } from "./support/require-defined.ts";

let sourceRepo: string | undefined;
let reposDir: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (sourceRepo) rmSync(sourceRepo, { recursive: true, force: true });
	if (reposDir) rmSync(reposDir, { recursive: true, force: true });
	sourceRepo = undefined;
	reposDir = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildSourceRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-source-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "README.md"), "hello\n");
	git(root, "add", "README.md");
	git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

function reference(): RepoReference {
	return { host: "local-fixture", owner: "acme", repo: "widgets", ref: null };
}

describe("createLectorService's repo.fetch", () => {
	it("rejects repo.fetch when the service was constructed without createRepoFetcher", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("repo.fetch", reference())).rejects.toBeInstanceOf(RepoFetcherNotConfigured);
	});

	it("fetches a real repo and registers it read-only in the same registry rawRead uses", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-cache-"));
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});

		const result = await service.dispatch("repo.fetch", reference());
		expect(result.fromCache).toBe(false);

		const read = await service.dispatch("workspace.rawRead", { workspaceId: result.workspaceId, path: "README.md" });
		expect(read.content).toBe("hello\n");

		await expect(
			service.dispatch("workspace.exactEdit", { workspaceId: result.workspaceId, path: "README.md", expectedHash: null, content: "changed\n" }),
		).rejects.toBeInstanceOf(WorkspaceIsReadOnly);
	});

	it("a second repo.fetch reuses the same workspaceId and logs the cache decision without the remote identity", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-cache-"));
		const { logger, calls } = recordingLogger();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			logger,
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});

		const first = await service.dispatch("repo.fetch", reference());
		const second = await service.dispatch("repo.fetch", reference());

		expect(second.fromCache).toBe(true);
		expect(second.workspaceId).toBe(first.workspaceId);
		expect(calls.filter((call) => call.message === "repository fetch completed").map((call) => call.fields)).toEqual([
			{ component: "repo-fetch", operation: "repo.fetch", fromCache: false },
			{ component: "repo-fetch", operation: "repo.fetch", fromCache: true },
		]);
		expect(JSON.stringify(calls)).not.toContain("acme");
		expect(JSON.stringify(calls)).not.toContain("widgets");
	});

	it("threads forceRefresh through to a real reclone -- the 'update' verb, previously unreachable through the public operation", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-cache-"));
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		await service.dispatch("repo.fetch", reference());
		git(requireDefined(sourceRepo, "sourceRepo"), "commit", "-q", "--allow-empty", "-m", "a new commit on the remote");

		const withoutForceRefresh = await service.dispatch("repo.fetch", reference());
		expect(withoutForceRefresh.fromCache).toBe(true);

		const withForceRefresh = await service.dispatch("repo.fetch", { ...reference(), forceRefresh: true });
		expect(withForceRefresh.fromCache).toBe(false);
		expect(withForceRefresh.commit).not.toBe(withoutForceRefresh.commit);
	});
});

describe("createLectorService's repo.evictCache", () => {
	it("rejects repo.evictCache when the service was constructed without createRepoFetcher", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("repo.evictCache", reference())).rejects.toBeInstanceOf(RepoFetcherNotConfigured);
	});

	it("returns evicted: false, not an error, for a reference that was never fetched", async () => {
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-cache-"));
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir")),
		});

		await expect(service.dispatch("repo.evictCache", reference())).resolves.toEqual({ evicted: false });
	});

	it("evicts a fetched, never-registered-elsewhere cache entry, reflected immediately in repo.listCache", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-cache-"));
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		// repo.fetch always registers a workspace for what it fetches -- evicting it while that
		// registration is still live is exactly the unsafe case the next test covers. This test
		// fetches through the port directly, bypassing repo.fetch's own registry side effect, to
		// isolate "evict a cache entry with no registered workspace" on its own.
		const fetcher = new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });
		await fetcher.fetch(reference());
		service = createLectorService(new Map(), { allowDynamicOnly: true, createRepoFetcher: () => fetcher });

		const result = await service.dispatch("repo.evictCache", reference());

		expect(result).toEqual({ evicted: true });
		const page = await service.dispatch("repo.listCache", { maxResults: 10 });
		expect(page.entries).toEqual([]);
	});

	it("refuses to evict a cache entry that is still a currently-registered workspace, with a clear typed error", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-cache-"));
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		const fetched = await service.dispatch("repo.fetch", reference());

		await expect(service.dispatch("repo.evictCache", reference())).rejects.toBeInstanceOf(RepoCacheEntryInUse);

		// Refusing must not have touched the cache or the registered workspace.
		const page = await service.dispatch("repo.listCache", { maxResults: 10 });
		expect(page.entries[0]?.registeredWorkspaceId).toBe(fetched.workspaceId);
		await expect(service.dispatch("workspace.rawRead", { workspaceId: fetched.workspaceId, path: "README.md" })).resolves.toMatchObject({ content: "hello\n" });
	});
});

describe("createLectorService's repo.listCache", () => {
	it("rejects repo.listCache when the service was constructed without createRepoFetcher", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("repo.listCache", { maxResults: 10 })).rejects.toBeInstanceOf(RepoFetcherNotConfigured);
	});

	it("returns an empty page, not an error, before anything has been fetched", async () => {
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-cache-"));
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir")),
		});

		const page = await service.dispatch("repo.listCache", { maxResults: 10 });

		expect(page).toEqual({ entries: [], nextCursor: null });
	});

	it("lists a fetched repository, distinguishing it as a currently-registered workspace", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-cache-"));
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		const fetched = await service.dispatch("repo.fetch", reference());

		const page = await service.dispatch("repo.listCache", { maxResults: 10 });

		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]).toMatchObject({ host: "local-fixture", owner: "acme", repo: "widgets", registeredWorkspaceId: fetched.workspaceId });
	});

	it("filters by host/owner/repo/ref and by free-text", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-cache-"));
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		await service.dispatch("repo.fetch", reference());
		await service.dispatch("repo.fetch", { host: "local-fixture", owner: "acme", repo: "other-widgets", ref: null });

		const byRepo = await service.dispatch("repo.listCache", { maxResults: 10, repo: "widgets" });
		expect(byRepo.entries.map((e) => e.repo)).toEqual(["widgets"]);

		const byText = await service.dispatch("repo.listCache", { maxResults: 10, text: "other" });
		expect(byText.entries.map((e) => e.repo)).toEqual(["other-widgets"]);
	});

	it("bounds a page to maxResults and resumes correctly from the returned cursor", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-cache-"));
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});
		await service.dispatch("repo.fetch", { host: "local-fixture", owner: "acme", repo: "a-widgets", ref: null });
		await service.dispatch("repo.fetch", { host: "local-fixture", owner: "acme", repo: "b-widgets", ref: null });

		const first = await service.dispatch("repo.listCache", { maxResults: 1 });
		expect(first.entries.map((e) => e.repo)).toEqual(["a-widgets"]);
		expect(first.nextCursor).not.toBeNull();

		const second = await service.dispatch("repo.listCache", { maxResults: 1, cursor: first.nextCursor ?? undefined });
		expect(second.entries.map((e) => e.repo)).toEqual(["b-widgets"]);
		expect(second.nextCursor).toBeNull();
	});
});
