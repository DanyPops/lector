/**
 * mapRepoFetchError must code/categorize each reachable domain error, preserve the original as
 * cause, and declare the matching codes on each operation's own descriptor (they differ per
 * operation, unlike git's identical 3-error catalog on all 3 operations).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError, type VehicleError } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { UnsafeGitArgument } from "../../../src/git/assert-safe-git-argument.ts";
import { UnsafePathSegment } from "../../../src/path-safety/assert-safe-path-segment.ts";
import { GitRepoFetcher } from "../../../src/repo-fetcher/git-repo-fetcher.ts";
import { registerRepoFetchOperations } from "../../../src/repo-fetcher/operation-registration.ts";
import type { RepoReference } from "../../../src/repo-fetcher/repo-reference.ts";
import { RepoCacheEntryInUse } from "../../../src/service/errors.ts";
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
	const root = mkdtempSync(join(tmpdir(), "lector-vehicle-repo-fetch-error-source-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "README.md"), "hello\n");
	git(root, "add", "README.md");
	git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

function buildFixture(repoFetcher: GitRepoFetcher | undefined) {
	const registry: MutableRegistry = new Map();
	const handlers = createRepoFetchHandlers({ repoFetcher, logger: { debug() {}, info() {}, warn() {}, error() {} } });
	const vehicleRegistry = new VehicleRegistry({ name: "lector-repo-fetch-error-mapping", version: "1.0.0", description: "test" });
	registerRepoFetchOperations(vehicleRegistry, registry, handlers);
	return { registry, handlers, vehicleRegistry };
}

async function invokeAndCatch(vehicleRegistry: VehicleRegistry, name: string, input: unknown, permissions: readonly string[]): Promise<VehicleError> {
	const error = await vehicleRegistry.invoke(name, 1, input, { permissions }).catch((caught: unknown) => caught);
	if (!isVehicleError(error)) throw new Error(`expected a VehicleError, got ${String(error)}`);
	return error;
}

describe("repo-fetch error mapping", () => {
	it("maps UnsafePathSegment to a coded VehicleError on repo.fetch", async () => {
		const { vehicleRegistry } = buildFixture(new GitRepoFetcher(mkdtempSync(join(tmpdir(), "lector-vehicle-repo-fetch-unsafe-"))));
		const reference: RepoReference = { host: "../escape", owner: "a", repo: "b", ref: null };

		const error = await invokeAndCatch(vehicleRegistry, "repo.fetch", reference, ["workspace:write"]);
		expect(error.code).toBe("unsafe-path-segment");
		expect(error.category).toBe("validation");
		expect(error.cause).toBeInstanceOf(UnsafePathSegment);
	});

	it("maps UnsafeGitArgument to a coded VehicleError on repo.fetch", async () => {
		const { vehicleRegistry } = buildFixture(new GitRepoFetcher(mkdtempSync(join(tmpdir(), "lector-vehicle-repo-fetch-unsafe-"))));
		const reference: RepoReference = { host: "github.com", owner: "a", repo: "b", ref: "-x" };

		const error = await invokeAndCatch(vehicleRegistry, "repo.fetch", reference, ["workspace:write"]);
		expect(error.code).toBe("unsafe-git-argument");
		expect(error.category).toBe("validation");
		expect(error.cause).toBeInstanceOf(UnsafeGitArgument);
	});

	it("maps RepoCacheEntryInUse to a coded VehicleError on repo.evictCache", async () => {
		sourceRepo = buildSourceRepo();
		reposDir = mkdtempSync(join(tmpdir(), "lector-vehicle-repo-fetch-conflict-"));
		const repoFetcher = new GitRepoFetcher(reposDir, { resolveCloneUrl: () => sourceRepo ?? "" });
		const { registry, handlers, vehicleRegistry } = buildFixture(repoFetcher);
		const reference: RepoReference = { host: "local-fixture", owner: "acme", repo: "widgets", ref: null };
		await handlers["repo.fetch"](registry, reference);

		const error = await invokeAndCatch(vehicleRegistry, "repo.evictCache", reference, ["workspace:write"]);
		expect(error.code).toBe("repo-cache-entry-in-use");
		expect(error.category).toBe("conflict");
		expect(error.cause).toBeInstanceOf(RepoCacheEntryInUse);
	});

	it("declares a per-operation error catalog through manifest(), not one shared superset", () => {
		const { vehicleRegistry } = buildFixture(new GitRepoFetcher(mkdtempSync(join(tmpdir(), "lector-vehicle-repo-fetch-manifest-"))));
		const manifest = vehicleRegistry.manifest();
		const codesFor = (name: string) =>
			manifest.operations
				.find((op) => op.name === name)
				?.errors.map((failure) => failure.code)
				.sort();

		expect(codesFor("repo.fetch")).toEqual(
			[
				"repo-fetcher-not-configured",
				"unsafe-path-segment",
				"unsafe-git-argument",
				"repo-fetch-capacity-exceeded",
				"repo-fetch-limit-exceeded",
				"repo-fetch-failed",
			].sort(),
		);
		expect(codesFor("repo.listCache")).toEqual(["repo-fetcher-not-configured"]);
		expect(codesFor("repo.evictCache")).toEqual(
			["repo-fetcher-not-configured", "unsafe-path-segment", "unsafe-git-argument", "repo-cache-entry-in-use"].sort(),
		);
	});
});
