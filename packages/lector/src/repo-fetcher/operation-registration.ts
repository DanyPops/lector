/** Fetch and eviction are safely retryable because repeated calls converge on the same cache state. */
import { bindVehicleOperation, defineErrorMapping, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { UnsafeGitArgument } from "../git/assert-safe-git-argument.ts";
import { WORKSPACE_READ_PERMISSION, WORKSPACE_WRITE_PERMISSION } from "../operation-dispatch/permissions.ts";
import { UnsafePathSegment } from "../path-safety/assert-safe-path-segment.ts";
import { RepoCacheEntryInUse, RepoFetcherNotConfigured } from "../service/errors.ts";
import type { RepoFetchHandlers } from "../service/repo-fetch-handlers.ts";
import type { MutableRegistry } from "../service/workspace-registry.ts";
import { repoEvictCacheInputSchema, repoFetchInputSchema, repoListCacheInputSchema } from "./input-schemas.ts";
import { RepoFetchCapacityExceeded, RepoFetchFailed, RepoFetchLimitExceeded } from "./repo-fetch-result.ts";

const OWNER = "lector-repo-fetch";

const WRITE_PERMISSIONS = [WORKSPACE_WRITE_PERMISSION];
const READ_PERMISSIONS = [WORKSPACE_READ_PERMISSION];

/** Local-disk operations (listCache/evictCache) stay on git's original bounds; fetch is a real network clone and gets a longer timeout. */
const LOCAL_LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 8_192, maxResponseBytes: 262_144 };
const FETCH_LIMITS = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000, maxRequestBytes: 8_192, maxResponseBytes: 8_192 };

const NOT_CONFIGURED_ERROR = { code: "repo-fetcher-not-configured", description: "the service was constructed without a repo fetcher configured" };
const UNSAFE_REFERENCE_ERRORS = [
	{ code: "unsafe-path-segment", description: 'host/owner/repo contains a path-unsafe value (separators, "..")' },
	{ code: "unsafe-git-argument", description: 'ref starts with "-" (git argv-flag injection guard)' },
];
const FETCH_ERRORS = [
	NOT_CONFIGURED_ERROR,
	...UNSAFE_REFERENCE_ERRORS,
	{ code: "repo-fetch-capacity-exceeded", description: "the fetch queue is full" },
	{ code: "repo-fetch-limit-exceeded", description: "the clone or cache size limit was exceeded" },
	{ code: "repo-fetch-failed", description: "the reference could not be fetched (network or git failure)" },
];
const EVICT_CACHE_ERRORS = [
	NOT_CONFIGURED_ERROR,
	...UNSAFE_REFERENCE_ERRORS,
	{ code: "repo-cache-entry-in-use", description: "the cached checkout is still a registered workspace" },
];

const mapRepoFetchError = defineErrorMapping([
	{ errorClass: RepoFetcherNotConfigured, category: "unavailable", code: "repo-fetcher-not-configured" },
	{ errorClass: UnsafePathSegment, category: "validation", code: "unsafe-path-segment" },
	{ errorClass: UnsafeGitArgument, category: "validation", code: "unsafe-git-argument" },
	{ errorClass: RepoFetchCapacityExceeded, category: "capacity", code: "repo-fetch-capacity-exceeded" },
	{ errorClass: RepoFetchLimitExceeded, category: "capacity", code: "repo-fetch-limit-exceeded" },
	{ errorClass: RepoFetchFailed, category: "unavailable", code: "repo-fetch-failed" },
	{ errorClass: RepoCacheEntryInUse, category: "conflict", code: "repo-cache-entry-in-use" },
]);

/** Registers repository-cache contracts without duplicating RepoFetchHandlers behavior. */
export function registerRepoFetchOperations(operationRegistry: VehicleRegistry, registry: MutableRegistry, handlers: RepoFetchHandlers): void {
	const fetch = defineVehicleOperation({
		name: "repo.fetch",
		version: 1,
		description: "Fetches (or reuses a cached clone of) an external repo and registers it read-only.",
		input: repoFetchInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "external-write",
		idempotency: { mode: "safe" },
		limits: FETCH_LIMITS,
		errors: FETCH_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(fetch, () => (context) => mapRepoFetchError(() => handlers["repo.fetch"](registry, context.input))),
	);

	const listCache = defineVehicleOperation({
		name: "repo.listCache",
		version: 1,
		description: "Lists every repository currently present in the disk cache, filtered and paginated.",
		input: repoListCacheInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LOCAL_LIMITS,
		errors: [NOT_CONFIGURED_ERROR],
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(listCache, () => (context) => mapRepoFetchError(() => handlers["repo.listCache"](registry, context.input))),
	);

	const evictCache = defineVehicleOperation({
		name: "repo.evictCache",
		version: 1,
		description: "Removes one cached checkout by its exact fetch identity, refusing while it's still a registered workspace.",
		input: repoEvictCacheInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "destructive",
		idempotency: { mode: "safe" },
		limits: LOCAL_LIMITS,
		errors: EVICT_CACHE_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(evictCache, () => (context) => mapRepoFetchError(() => handlers["repo.evictCache"](registry, context.input))),
	);
}

export { READ_PERMISSIONS as REPO_LIST_CACHE_PERMISSIONS, WRITE_PERMISSIONS as REPO_WRITE_PERMISSIONS };
