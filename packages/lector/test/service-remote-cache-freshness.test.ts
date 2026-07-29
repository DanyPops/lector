/**
 * Service-level wiring for the remote-change watcher: a remote-tracked workspace's
 * cacheStatus/populateSymbolGraph auto-refetch in place when the tracked ref has genuinely
 * moved on the remote, on demand and with no debounce -- proven against a real GitRepoFetcher
 * over a real local git repo standing in for "the remote", not a mocked git binary. Domain-level
 * decision logic (shouldRefetchFromRemote) is already covered directly in
 * test/domain/remote-cache-freshness.test.ts; GitRepoFetcher.resolveRemoteCommit correctness is
 * already covered directly in test/adapters/git-repo-fetcher.test.ts. This file only proves the
 * two are wired together correctly through the service.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepoFetcher } from "../src/adapters/git-repo-fetcher.ts";
import { LspSymbolIndex } from "../src/adapters/lsp/lsp-symbol-index.ts";
import type { RepoFetchPolicy, RepoFetchResult } from "../src/domain/repo-fetch-result.ts";
import type { RepoReference } from "../src/domain/repo-reference.ts";
import type { RepoFetcherPort } from "../src/ports/repo-fetcher-port.ts";
import { createLectorService, type LectorService } from "../src/service.ts";
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
	const root = mkdtempSync(join(tmpdir(), "lector-remote-freshness-source-"));
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "chain.ts"), "export function a(): number {\n\treturn 1;\n}\n");
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	git(root, "add", ".");
	git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

function reference(): RepoReference {
	return { host: "local-fixture", owner: "acme", repo: "widgets", ref: "main" };
}

/** Counts resolveRemoteCommit/fetch calls without changing GitRepoFetcher's own real behavior. */
class CountingRepoFetcher implements RepoFetcherPort {
	resolveRemoteCommitCalls = 0;
	fetchCalls = 0;
	constructor(private readonly inner: GitRepoFetcher) {}
	fetch(reference: RepoReference, policy?: RepoFetchPolicy): Promise<RepoFetchResult> {
		this.fetchCalls++;
		return this.inner.fetch(reference, policy);
	}
	resolveRemoteCommit(reference: RepoReference, timeoutMs?: number): Promise<string | undefined> {
		this.resolveRemoteCommitCalls++;
		return this.inner.resolveRemoteCommit(reference, timeoutMs);
	}
}

function buildService(fetcher: RepoFetcherPort): LectorService {
	return createLectorService(new Map(), {
		allowDynamicOnly: true,
		createRepoFetcher: () => fetcher,
		createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
	});
}

describe("createLectorService's remote-change watcher", () => {
	it("auto-refetches and re-populates once the tracked remote ref has genuinely moved, on the very next cacheStatus/populateSymbolGraph call", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-remote-freshness-cache-"));
		const fetcher = new CountingRepoFetcher(new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }));
		service = buildService(fetcher);

		const { workspaceId } = await service.dispatch("repo.fetch", reference());
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		const fresh = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(fresh.status).toBe("cached");

		// The remote genuinely advances -- a real new commit on the same tracked branch.
		writeFileSync(
			join(sourceRepo, "chain.ts"),
			"export function a(): number {\n\treturn 1;\n}\n\nexport function addedAfterFetch(): number {\n\treturn 2;\n}\n",
		);
		git(sourceRepo, "commit", "-q", "-am", "add a new function after the initial fetch");

		const afterRemoteMoved = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(afterRemoteMoved.status).toBe("not-cached");
		expect(fetcher.fetchCalls).toBe(2); // the initial repo.fetch, plus this auto-refetch

		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		const symbols = await service.dispatch("workspace.findSymbols", { workspaceId, query: "addedAfterFetch" });
		expect(symbols.symbols.some((symbol) => symbol.name === "addedAfterFetch")).toBe(true);
	}, 30_000);

	it("never refetches when the remote hasn't moved, even though every call still pays the cheap ls-remote check -- no debounce, but no wasted refetch either", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-remote-freshness-cache-"));
		const fetcher = new CountingRepoFetcher(new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }));
		service = buildService(fetcher);

		const { workspaceId } = await service.dispatch("repo.fetch", reference());
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		fetcher.resolveRemoteCommitCalls = 0;

		const first = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		const second = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		expect(first.status).toBe("cached");
		expect(second.status).toBe("cached");
		expect(fetcher.resolveRemoteCommitCalls).toBe(2); // every call re-checks -- no cooldown/debounce
		expect(fetcher.fetchCalls).toBe(1); // only the original repo.fetch -- nothing genuinely moved
	}, 30_000);

	it("keeps serving the last known-good cache when the remote check itself is inconclusive, instead of forcing a failing refetch", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-remote-freshness-cache-"));
		const real = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") });
		const fetcher = new CountingRepoFetcher(real);
		service = buildService(fetcher);

		const { workspaceId } = await service.dispatch("repo.fetch", reference());
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		// The remote becomes unreachable -- resolveRemoteCommit degrades to undefined, per its
		// own documented contract, never a throw.
		rmSync(sourceRepo, { recursive: true, force: true });

		const status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		expect(status.status).toBe("cached");
		expect(fetcher.fetchCalls).toBe(1); // never re-attempted a refetch it already knows would also fail
		sourceRepo = undefined; // already removed above
	}, 30_000);
});
