/**
 * Each source's own mapXSearchError must code/categorize its reachable domain errors, preserve
 * the original as cause, and declare the matching per-operation codes on its own descriptor.
 */
import { describe, expect, it } from "bun:test";
import { isVehicleError, type VehicleError, type VehicleFailureCategory } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { registerExternalSearchOperations } from "../../../src/external-search/operation-registration.ts";
import { InMemoryExternalSearchCache } from "../../../src/external-search-cache/in-memory-external-search-cache.ts";
import {
	GithubSearchRateLimited,
	GithubSearchRequestFailed,
	GithubSearchResponseLimitExceeded,
	InvalidGithubSearchRequest,
} from "../../../src/github-search/github-search-client.ts";
import type { GithubSearchPort } from "../../../src/github-search/port.ts";
import { InvalidNpmRegistryRequest, NpmRegistryRequestFailed, NpmRegistryResponseLimitExceeded } from "../../../src/npm-registry/npm-registry-client.ts";
import type { NpmRegistryPort } from "../../../src/npm-registry/port.ts";
import { createExternalSearchHandlers } from "../../../src/service/external-search-handlers.ts";
import type { MutableRegistry } from "../../../src/service/workspace-registry.ts";
import type { SourcegraphSearchPort } from "../../../src/sourcegraph-search/port.ts";
import {
	InvalidSourcegraphSearchRequest,
	SourcegraphSearchRequestFailed,
	SourcegraphSearchResponseLimitExceeded,
} from "../../../src/sourcegraph-search/sourcegraph-search-client.ts";

function throwingGithub(error: Error): GithubSearchPort {
	return {
		async searchRepos() {
			throw error;
		},
	};
}
function throwingNpm(error: Error): NpmRegistryPort {
	return {
		async fetchVersion(): Promise<never> {
			throw new Error("not used by these tests");
		},
		async search() {
			throw error;
		},
	};
}
function throwingSourcegraph(error: Error): SourcegraphSearchPort {
	return {
		async searchCode() {
			throw error;
		},
	};
}

function buildFixture(ports: { githubSearch: GithubSearchPort; npmRegistry: NpmRegistryPort; sourcegraphSearch: SourcegraphSearchPort }) {
	const registry: MutableRegistry = new Map();
	const handlers = createExternalSearchHandlers({
		...ports,
		githubSearchCache: new InMemoryExternalSearchCache(),
		npmSearchCache: new InMemoryExternalSearchCache(),
		sourcegraphSearchCache: new InMemoryExternalSearchCache(),
	});
	const vehicleRegistry = new VehicleRegistry({ name: "lector-external-search-error-mapping", version: "1.0.0", description: "test" });
	registerExternalSearchOperations(vehicleRegistry, registry, handlers);
	return vehicleRegistry;
}

async function invokeAndCatch(vehicleRegistry: VehicleRegistry, name: string, input: unknown): Promise<VehicleError> {
	const error = await vehicleRegistry.invoke(name, 1, input, { permissions: ["external-search:read"] }).catch((caught: unknown) => caught);
	if (!isVehicleError(error)) throw new Error(`expected a VehicleError, got ${String(error)}`);
	return error;
}

const NOOP_PORTS = {
	githubSearch: throwingGithub(new Error("unused")),
	npmRegistry: throwingNpm(new Error("unused")),
	sourcegraphSearch: throwingSourcegraph(new Error("unused")),
};

describe("external-search error mapping", () => {
	it("maps every reachable GitHub error to its own coded VehicleError, cause preserved", async () => {
		const cases: [Error, string, VehicleFailureCategory][] = [
			[new InvalidGithubSearchRequest("query"), "invalid-github-search-request", "validation"],
			[new GithubSearchRateLimited(30), "github-search-rate-limited", "capacity"],
			[new GithubSearchResponseLimitExceeded(1024), "github-search-response-limit-exceeded", "capacity"],
			[new GithubSearchRequestFailed("request-failed"), "github-search-request-failed", "unavailable"],
		];
		for (const [thrown, code, category] of cases) {
			const vehicleRegistry = buildFixture({ ...NOOP_PORTS, githubSearch: throwingGithub(thrown) });
			const error = await invokeAndCatch(vehicleRegistry, "search.githubRepos", { query: "widgets", maxResults: 10 });
			expect(error.code).toBe(code);
			expect(error.category).toBe(category);
			expect(error.cause).toBe(thrown);
		}
	});

	it("maps every reachable npm error to its own coded VehicleError, cause preserved", async () => {
		const cases: [Error, string, VehicleFailureCategory][] = [
			[new InvalidNpmRegistryRequest("query"), "invalid-npm-registry-request", "validation"],
			[new NpmRegistryResponseLimitExceeded(1024, 2048), "npm-registry-response-limit-exceeded", "capacity"],
			[new NpmRegistryRequestFailed("request-failed"), "npm-registry-request-failed", "unavailable"],
		];
		for (const [thrown, code, category] of cases) {
			const vehicleRegistry = buildFixture({ ...NOOP_PORTS, npmRegistry: throwingNpm(thrown) });
			const error = await invokeAndCatch(vehicleRegistry, "search.npmPackages", { query: "widgets", maxResults: 10 });
			expect(error.code).toBe(code);
			expect(error.category).toBe(category);
			expect(error.cause).toBe(thrown);
		}
	});

	it("maps every reachable Sourcegraph error to its own coded VehicleError, cause preserved", async () => {
		const cases: [Error, string, VehicleFailureCategory][] = [
			[new InvalidSourcegraphSearchRequest("query"), "invalid-sourcegraph-search-request", "validation"],
			[new SourcegraphSearchResponseLimitExceeded(1024), "sourcegraph-search-response-limit-exceeded", "capacity"],
			[new SourcegraphSearchRequestFailed("request-failed"), "sourcegraph-search-request-failed", "unavailable"],
		];
		for (const [thrown, code, category] of cases) {
			const vehicleRegistry = buildFixture({ ...NOOP_PORTS, sourcegraphSearch: throwingSourcegraph(thrown) });
			const error = await invokeAndCatch(vehicleRegistry, "search.sourcegraphCode", { query: "widgets", maxResults: 10 });
			expect(error.code).toBe(code);
			expect(error.category).toBe(category);
			expect(error.cause).toBe(thrown);
		}
	});

	it("declares each operation's own distinct error catalog through manifest()", () => {
		const vehicleRegistry = buildFixture(NOOP_PORTS);
		const manifest = vehicleRegistry.manifest();
		const codesFor = (name: string) =>
			manifest.operations
				.find((op) => op.name === name)
				?.errors.map((failure) => failure.code)
				.sort();

		expect(codesFor("search.githubRepos")).toEqual(
			["invalid-github-search-request", "github-search-rate-limited", "github-search-response-limit-exceeded", "github-search-request-failed"].sort(),
		);
		expect(codesFor("search.npmPackages")).toEqual(
			["invalid-npm-registry-request", "npm-registry-response-limit-exceeded", "npm-registry-request-failed"].sort(),
		);
		expect(codesFor("search.sourcegraphCode")).toEqual(
			["invalid-sourcegraph-search-request", "sourcegraph-search-response-limit-exceeded", "sourcegraph-search-request-failed"].sort(),
		);
	});
});
