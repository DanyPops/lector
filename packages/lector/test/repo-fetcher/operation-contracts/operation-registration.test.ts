/** Registry and direct repository-cache entry points must preserve behavior and failure identity. */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { GitRepoFetcher } from "../../../src/repo-fetcher/git-repo-fetcher.ts";
import { registerRepoFetchOperations } from "../../../src/repo-fetcher/operation-registration.ts";
import type { RepoReference } from "../../../src/repo-fetcher/repo-reference.ts";
import { RepoFetcherNotConfigured } from "../../../src/service/errors.ts";
import { createRepoFetchHandlers } from "../../../src/service/repo-fetch-handlers.ts";
import type { MutableRegistry } from "../../../src/service/workspace-registry.ts";

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

function buildSourceRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-vehicle-repo-fetch-source-"));
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

const READ_PERMISSIONS = ["workspace:read"];
const WRITE_PERMISSIONS = ["workspace:write"];

function buildFixture(repoFetcher: GitRepoFetcher | undefined) {
	const registry: MutableRegistry = new Map();
	const handlers = createRepoFetchHandlers({ repoFetcher, logger: { debug() {}, info() {}, warn() {}, error() {} } });
	const vehicleRegistry = new VehicleRegistry({ name: "lector-repo-fetch", version: "1.0.0", description: "test" });
	registerRepoFetchOperations(vehicleRegistry, registry, handlers);
	return { registry, handlers, vehicleRegistry };
}

describe("registerRepoFetchOperations", () => {
	it("invoke() matches the direct handler call for fetch and listCache", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-vehicle-repo-fetch-cache-"));
		const repoFetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => sourceRepo ?? "" });
		const { registry, handlers, vehicleRegistry } = buildFixture(repoFetcher);

		const directFetch = await handlers["repo.fetch"](registry, reference());
		const vehicleFetch = (await vehicleRegistry.invoke("repo.fetch", 1, reference(), { permissions: WRITE_PERMISSIONS })) as typeof directFetch;
		// The direct call already primed the cache, so only the vehicle-invoked call sees fromCache: true.
		expect(vehicleFetch.fromCache).toBe(true);
		expect({ ...vehicleFetch, fromCache: undefined }).toEqual({ ...directFetch, fromCache: undefined });

		const directList = await handlers["repo.listCache"](registry, { maxResults: 10 });
		const vehicleList = await vehicleRegistry.invoke("repo.listCache", 1, { maxResults: 10 }, { permissions: READ_PERMISSIONS });
		expect(vehicleList).toEqual(directList);
	});

	it("invoke() matches the direct handler call for evictCache, on a cached-but-unregistered entry", async () => {
		// repo.fetch always registers a workspace for what it fetches -- fetching through the port
		// directly isolates "evict a cache entry with no registered workspace" on its own, the same
		// way service-repo-fetch.test.ts's own equivalent test does.
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-vehicle-repo-fetch-cache-"));
		const repoFetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => sourceRepo ?? "" });
		const { registry, handlers, vehicleRegistry } = buildFixture(repoFetcher);
		const directRef = { ...reference(), repo: "widgets-direct" };
		const vehicleRef = { ...reference(), repo: "widgets-vehicle" };
		await repoFetcher.fetch(directRef);
		await repoFetcher.fetch(vehicleRef);

		const directEvict = await handlers["repo.evictCache"](registry, directRef);
		expect(directEvict).toEqual({ evicted: true });
		const vehicleEvict = await vehicleRegistry.invoke("repo.evictCache", 1, vehicleRef, { permissions: WRITE_PERMISSIONS });
		expect(vehicleEvict).toEqual(directEvict);
	});

	it("a RepoFetcherNotConfigured failure survives as invoke()'s VehicleError.cause", async () => {
		const { vehicleRegistry } = buildFixture(undefined);

		const vehicleError = await vehicleRegistry.invoke("repo.fetch", 1, reference(), { permissions: WRITE_PERMISSIONS }).catch((error: unknown) => error);
		expect(isVehicleError(vehicleError)).toBe(true);
		expect((vehicleError as Error).cause).toBeInstanceOf(RepoFetcherNotConfigured);
	});
});
