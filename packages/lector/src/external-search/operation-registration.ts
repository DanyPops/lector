/** All three sources are safely retryable: each is a pure read with no side effect, and a repeated call with the same query+maxResults just re-serves (or re-populates) the same short-TTL cache entry. */
import { bindVehicleOperation, defineErrorMapping, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import {
	GithubSearchRateLimited,
	GithubSearchRequestFailed,
	GithubSearchResponseLimitExceeded,
	InvalidGithubSearchRequest,
} from "../github-search/github-search-client.ts";
import { InvalidNpmRegistryRequest, NpmRegistryRequestFailed, NpmRegistryResponseLimitExceeded } from "../npm-registry/npm-registry-client.ts";
import type { ExternalSearchHandlers } from "../service/external-search-handlers.ts";
import type { MutableRegistry } from "../service/workspace-registry.ts";
import {
	InvalidSourcegraphSearchRequest,
	SourcegraphSearchRequestFailed,
	SourcegraphSearchResponseLimitExceeded,
} from "../sourcegraph-search/sourcegraph-search-client.ts";
import { searchGithubReposInputSchema, searchNpmPackagesInputSchema, searchSourcegraphCodeInputSchema } from "./input-schemas.ts";

const OWNER = "lector-external-search";

/**
 * None of the three sources ever touches a workspace or the local filesystem -- a real network
 * read against a third-party service, distinct from WORKSPACE_READ_PERMISSION's own "reads
 * something inside a registered workspace" scope. The first caller with a genuine need for this
 * distinction (mirrors repo-fetch's own WORKSPACE_WRITE_PERMISSION addition, added exactly when
 * the first real write-shaped operation appeared).
 */
export const EXTERNAL_SEARCH_PERMISSION = "external-search:read";
export const EXTERNAL_SEARCH_PERMISSIONS = [EXTERNAL_SEARCH_PERMISSION];

/** A real network call to a third party; longer and more generous than a local/workspace-bound operation's own defaults. */
const LIMITS = { defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000, maxRequestBytes: 2_048, maxResponseBytes: 8 * 1024 * 1024 };

const GITHUB_ERRORS = [
	{ code: "invalid-github-search-request", description: "the query or maxResults failed the GitHub search client's own validation" },
	{ code: "github-search-rate-limited", description: "GitHub's own rate limit was hit (primary or secondary)" },
	{ code: "github-search-response-limit-exceeded", description: "GitHub's response exceeded the configured byte limit" },
	{ code: "github-search-request-failed", description: "the request failed, timed out, or GitHub returned an invalid response" },
];
const NPM_ERRORS = [
	{ code: "invalid-npm-registry-request", description: "the query or maxResults failed the npm registry client's own validation" },
	{ code: "npm-registry-response-limit-exceeded", description: "the npm registry's response exceeded the configured byte limit" },
	{ code: "npm-registry-request-failed", description: "the request failed, timed out, or the registry returned an invalid response" },
];
const SOURCEGRAPH_ERRORS = [
	{ code: "invalid-sourcegraph-search-request", description: "the query or maxResults failed the Sourcegraph search client's own validation" },
	{ code: "sourcegraph-search-response-limit-exceeded", description: "Sourcegraph's response exceeded the configured byte limit" },
	{ code: "sourcegraph-search-request-failed", description: "the request failed, timed out, alerted, or Sourcegraph returned an invalid response" },
];

const mapGithubSearchError = defineErrorMapping([
	{ errorClass: InvalidGithubSearchRequest, category: "validation", code: "invalid-github-search-request" },
	{ errorClass: GithubSearchRateLimited, category: "capacity", code: "github-search-rate-limited" },
	{ errorClass: GithubSearchResponseLimitExceeded, category: "capacity", code: "github-search-response-limit-exceeded" },
	{ errorClass: GithubSearchRequestFailed, category: "unavailable", code: "github-search-request-failed" },
]);
const mapNpmSearchError = defineErrorMapping([
	{ errorClass: InvalidNpmRegistryRequest, category: "validation", code: "invalid-npm-registry-request" },
	{ errorClass: NpmRegistryResponseLimitExceeded, category: "capacity", code: "npm-registry-response-limit-exceeded" },
	{ errorClass: NpmRegistryRequestFailed, category: "unavailable", code: "npm-registry-request-failed" },
]);
const mapSourcegraphSearchError = defineErrorMapping([
	{ errorClass: InvalidSourcegraphSearchRequest, category: "validation", code: "invalid-sourcegraph-search-request" },
	{ errorClass: SourcegraphSearchResponseLimitExceeded, category: "capacity", code: "sourcegraph-search-response-limit-exceeded" },
	{ errorClass: SourcegraphSearchRequestFailed, category: "unavailable", code: "sourcegraph-search-request-failed" },
]);

/** Registers search.githubRepos/npmPackages/sourcegraphCode without duplicating ExternalSearchHandlers behavior. */
export function registerExternalSearchOperations(operationRegistry: VehicleRegistry, registry: MutableRegistry, handlers: ExternalSearchHandlers): void {
	const githubRepos = defineVehicleOperation({
		name: "search.githubRepos",
		version: 1,
		description: "Searches GitHub repositories by name/description/topic, shaped as direct repo.fetch inputs.",
		input: searchGithubReposInputSchema,
		output: passthroughVehicleSchema,
		permissions: EXTERNAL_SEARCH_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: GITHUB_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(githubRepos, () => (context) => mapGithubSearchError(() => handlers["search.githubRepos"](registry, context.input))),
	);

	const npmPackages = defineVehicleOperation({
		name: "search.npmPackages",
		version: 1,
		description: "Searches the public npm registry, shaped as direct package.resolveSource inputs.",
		input: searchNpmPackagesInputSchema,
		output: passthroughVehicleSchema,
		permissions: EXTERNAL_SEARCH_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: NPM_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(npmPackages, () => (context) => mapNpmSearchError(() => handlers["search.npmPackages"](registry, context.input))),
	);

	const sourcegraphCode = defineVehicleOperation({
		name: "search.sourcegraphCode",
		version: 1,
		description: "Searches code content across public GitHub via sourcegraph.com.",
		input: searchSourcegraphCodeInputSchema,
		output: passthroughVehicleSchema,
		permissions: EXTERNAL_SEARCH_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: SOURCEGRAPH_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(sourcegraphCode, () => (context) => mapSourcegraphSearchError(() => handlers["search.sourcegraphCode"](registry, context.input))),
	);
}
