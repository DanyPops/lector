/**
 * external_search's operations layer against a real running Lector daemon with a fake port
 * injected -- real HTTP client correctness (GitHub/npm/Sourcegraph) is already covered directly
 * in @danypops/lector's own adapter tests.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type {
	GithubRepoSearchResult,
	GithubSearchPort,
	NpmPackageCandidate,
	NpmRegistryPort,
	SourcegraphCodeCandidate,
	SourcegraphSearchPort,
} from "@danypops/lector";
import { createExternalSearchOperations } from "../extension/src/external-search-operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
});

class FakeGithubSearch implements GithubSearchPort {
	async searchRepos(query: string): Promise<GithubRepoSearchResult> {
		return {
			candidates: [{ host: "github.com", owner: "acme", repo: query, description: null, stars: 7, language: "Go", url: `https://github.com/acme/${query}` }],
			authenticated: true,
		};
	}
}

class FakeNpmRegistry implements NpmRegistryPort {
	async fetchVersion(): Promise<never> {
		throw new Error("not used by this test");
	}
	async search(query: string): Promise<readonly NpmPackageCandidate[]> {
		return [{ name: query, version: "1.0.0", description: null, repositoryUrl: null, score: 0.4 }];
	}
}

class FakeSourcegraphSearch implements SourcegraphSearchPort {
	async searchCode(query: string): Promise<readonly SourcegraphCodeCandidate[]> {
		return [
			{
				repository: "github.com/acme/widgets",
				path: `${query}.ts`,
				lineMatches: [],
				url: `https://sourcegraph.com/github.com/acme/widgets/-/blob/${query}.ts`,
			},
		];
	}
}

describe("Lector-backed external search operations", () => {
	it("githubRepos calls search.githubRepos via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon({ createGithubSearch: () => new FakeGithubSearch() });
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const result = await createExternalSearchOperations().githubRepos("widgets", 10);

		expect(result.authenticated).toBe(true);
		expect(result.candidates).toEqual([
			{ host: "github.com", owner: "acme", repo: "widgets", description: null, stars: 7, language: "Go", url: "https://github.com/acme/widgets" },
		]);
	});

	it("npmPackages calls search.npmPackages via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon({ createNpmRegistry: () => new FakeNpmRegistry() });
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const result = await createExternalSearchOperations().npmPackages("widgets", 10);

		expect(result.candidates).toEqual([{ name: "widgets", version: "1.0.0", description: null, repositoryUrl: null, score: 0.4 }]);
	});

	it("sourcegraphCode calls search.sourcegraphCode via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon({ createSourcegraphSearch: () => new FakeSourcegraphSearch() });
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const result = await createExternalSearchOperations().sourcegraphCode("widget", 10);

		expect(result.candidates).toEqual([
			{ repository: "github.com/acme/widgets", path: "widget.ts", lineMatches: [], url: "https://sourcegraph.com/github.com/acme/widgets/-/blob/widget.ts" },
		]);
	});
});
