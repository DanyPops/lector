/**
 * Service-level wiring for repo.fetch: a real GitRepoFetcher clone lands in the same
 * workspace registry every other operation reads from -- rawRead sees it, writeEntry
 * rejects it. Real GitRepoFetcher correctness (eviction, ref fallback, atomicity) is
 * already covered directly in test/adapters/git-repo-fetcher.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepoFetcher } from "../src/adapters/git-repo-fetcher.ts";
import { WorkspaceIsReadOnly } from "../src/adapters/read-only-workspace.ts";
import type { RepoReference } from "../src/domain/repo-reference.ts";
import { createLectorService, type LectorService, RepoFetcherNotConfigured } from "../src/service.ts";
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

	it("a second repo.fetch of the same reference reuses the same workspaceId, not a new registration", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-repo-fetch-service-cache-"));
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createRepoFetcher: () => new GitRepoFetcher(requireDefined(reposDir, "reposDir"), { resolveCloneUrl: () => requireDefined(sourceRepo, "sourceRepo") }),
		});

		const first = await service.dispatch("repo.fetch", reference());
		const second = await service.dispatch("repo.fetch", reference());

		expect(second.fromCache).toBe(true);
		expect(second.workspaceId).toBe(first.workspaceId);
	});
});
