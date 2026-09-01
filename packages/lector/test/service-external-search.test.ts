/**
 * Service-level wiring for search.githubRepos/search.npmPackages/search.sourcegraphCode:
 * bounds validation, per-source short-TTL caching, and dispatch to whichever port a caller
 * (or the real default client) supplies. Real client HTTP correctness is already covered
 * directly in test/adapters/{github,sourcegraph}-search-client.test.ts and
 * test/npm-registry/npm-registry-client.test.ts's own search() tests.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { isVehicleError } from "@danypops/vehicle-core";
import type {
	ExternalSearchBounds,
	GithubRepoSearchResult,
	NpmPackageCandidate,
	SourcegraphCodeSearchResult,
} from "../src/external-search/external-search-result.ts";
import type { GithubSearchPort } from "../src/github-search/port.ts";
import type { NpmRegistryPort } from "../src/npm-registry/port.ts";
import { createLectorService, type LectorService } from "../src/service.ts";
import type { SourcegraphSearchPort } from "../src/sourcegraph-search/port.ts";

let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
});

class CountingGithubSearch implements GithubSearchPort {
	calls = 0;
	async searchRepos(query: string): Promise<GithubRepoSearchResult> {
		this.calls++;
		return {
			candidates: [{ host: "github.com", owner: "acme", repo: query, description: null, stars: 1, language: null, url: `https://github.com/acme/${query}` }],
			authenticated: false,
		};
	}
}

class CountingNpmRegistry implements NpmRegistryPort {
	calls = 0;
	async fetchVersion(): Promise<never> {
		throw new Error("not used by these tests");
	}
	async search(query: string): Promise<readonly NpmPackageCandidate[]> {
		this.calls++;
		return [{ name: query, version: "1.0.0", description: null, repositoryUrl: null, score: 0.5 }];
	}
}

class CountingSourcegraphSearch implements SourcegraphSearchPort {
	calls = 0;
	async searchCode(query: string): Promise<SourcegraphCodeSearchResult> {
		this.calls++;
		return {
			candidates: [
				{
					repository: "github.com/acme/widgets",
					path: `${query}.ts`,
					lineMatches: [],
					url: `https://sourcegraph.com/github.com/acme/widgets/-/blob/${query}.ts`,
				},
			],
			completeness: "partial",
			truncated: true,
			stopReason: "deadline",
			bytesRead: 100,
		};
	}
}

describe("createLectorService's external search operations", () => {
	it("dispatches search.githubRepos to the configured port and caches the result for an identical query", async () => {
		const githubSearch = new CountingGithubSearch();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createGithubSearch: () => githubSearch });

		const first = await service.dispatch("search.githubRepos", { query: "widgets", maxResults: 10 });
		const second = await service.dispatch("search.githubRepos", { query: "widgets", maxResults: 10 });

		expect(first.candidates[0]?.repo).toBe("widgets");
		expect(second).toEqual(first);
		expect(githubSearch.calls).toBe(1);
	});

	it("dispatches search.npmPackages to the configured registry port and caches the result", async () => {
		const npmRegistry = new CountingNpmRegistry();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createNpmRegistry: () => npmRegistry });

		const first = await service.dispatch("search.npmPackages", { query: "widgets", maxResults: 10 });
		const second = await service.dispatch("search.npmPackages", { query: "widgets", maxResults: 10 });

		expect(first.candidates[0]?.name).toBe("widgets");
		expect(second).toEqual(first);
		expect(npmRegistry.calls).toBe(1);
	});

	it("dispatches search.sourcegraphCode to the configured port and caches the result", async () => {
		const sourcegraphSearch = new CountingSourcegraphSearch();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSourcegraphSearch: () => sourcegraphSearch });

		const first = await service.dispatch("search.sourcegraphCode", { query: "widget", maxResults: 10 });
		const second = await service.dispatch("search.sourcegraphCode", { query: "widget", maxResults: 10 });

		expect(first.candidates[0]?.path).toBe("widget.ts");
		expect(first).toMatchObject({ completeness: "partial", truncated: true, stopReason: "deadline" });
		expect(second).toEqual(first);
		expect(sourcegraphSearch.calls).toBe(1);
	});

	it("does not serve a cached result across a different query or maxResults", async () => {
		const githubSearch = new CountingGithubSearch();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createGithubSearch: () => githubSearch });

		await service.dispatch("search.githubRepos", { query: "widgets", maxResults: 10 });
		await service.dispatch("search.githubRepos", { query: "gadgets", maxResults: 10 });
		await service.dispatch("search.githubRepos", { query: "widgets", maxResults: 5 });

		expect(githubSearch.calls).toBe(3);
	});

	it("rejects maxResults outside the service's own bound with a structured VehicleError before ever calling the port", async () => {
		const githubSearch = new CountingGithubSearch();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createGithubSearch: () => githubSearch });

		// A malformed maxResults now fails at VehicleRegistry.invoke()'s own input-schema validation --
		// before the operation registry ever routes to the handler -- matching every other migrated
		// operation's own bound-violation shape (repo.fetch, workspace.gitStatus, ...), not a raw
		// TypeError thrown from inside the handler.
		const tooSmall = await service.dispatch("search.githubRepos", { query: "widgets", maxResults: 0 }).catch((caught: unknown) => caught);
		expect(isVehicleError(tooSmall)).toBe(true);
		expect((tooSmall as import("@danypops/vehicle-core").VehicleError).code).toBe("invalid-input");
		expect((tooSmall as import("@danypops/vehicle-core").VehicleError).category).toBe("validation");

		const tooLarge = await service.dispatch("search.githubRepos", { query: "widgets", maxResults: 10_000 }).catch((caught: unknown) => caught);
		expect(isVehicleError(tooLarge)).toBe(true);
		expect((tooLarge as import("@danypops/vehicle-core").VehicleError).code).toBe("invalid-input");

		expect(githubSearch.calls).toBe(0);
	});

	it("works with the real default clients when none are configured (construction alone makes no network call)", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		expect(service).toBeDefined();
	});

	it("passes the service's own fixed transport bounds through to the port, not a caller-supplied value", async () => {
		let observedBounds: ExternalSearchBounds | undefined;
		const githubSearch: GithubSearchPort = {
			async searchRepos(_query, bounds) {
				observedBounds = bounds;
				return { candidates: [], authenticated: false };
			},
		};
		service = createLectorService(new Map(), { allowDynamicOnly: true, createGithubSearch: () => githubSearch });

		await service.dispatch("search.githubRepos", { query: "widgets", maxResults: 7 });

		expect(observedBounds).toEqual(
			expect.objectContaining({ maxResults: 7, timeoutMs: expect.any(Number), maxResponseBytes: expect.any(Number), maxRetries: expect.any(Number) }),
		);
	});
});
