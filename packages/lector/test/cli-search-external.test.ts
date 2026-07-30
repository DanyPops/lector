/**
 * End-to-end CLI parity for `lector search github-repos/npm-packages/sourcegraph-code`, against
 * a real spawned daemon with a fake port injected -- real HTTP client correctness is already
 * covered directly in test/adapters/{github,sourcegraph}-search-client.test.ts and
 * test/adapters/npm-registry-client.test.ts's own search() tests.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeCandidate } from "../src/domain/external-search-result.ts";
import type { GithubSearchPort } from "../src/ports/github-search-port.ts";
import type { NpmRegistryPort } from "../src/ports/npm-registry-port.ts";
import type { SourcegraphSearchPort } from "../src/ports/sourcegraph-search-port.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let daemon: RunningDaemon | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	isolated?.cleanup();
	isolated = undefined;
});

async function runCli(args: readonly string[]): Promise<string> {
	if (!isolated) throw new Error("isolated daemon paths not initialized");
	const child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, ...args], {
		env: { ...process.env, XDG_DATA_HOME: isolated.root, XDG_STATE_HOME: isolated.root, XDG_RUNTIME_DIR: isolated.root, XDG_CONFIG_HOME: isolated.root },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stderr}`);
	return stdout.trim();
}

class FakeGithubSearch implements GithubSearchPort {
	async searchRepos(query: string): Promise<GithubRepoSearchResult> {
		return {
			candidates: [
				{
					host: "github.com",
					owner: "acme",
					repo: query,
					description: "a widget factory",
					stars: 42,
					language: "TypeScript",
					url: `https://github.com/acme/${query}`,
				},
			],
			authenticated: false,
		};
	}
}

class FakeNpmRegistry implements NpmRegistryPort {
	async fetchVersion(): Promise<never> {
		throw new Error("not used by this test");
	}
	async search(query: string): Promise<readonly NpmPackageCandidate[]> {
		return [{ name: query, version: "2.0.0", description: "a widget factory", repositoryUrl: "https://github.com/acme/widgets", score: 0.9 }];
	}
}

class FakeSourcegraphSearch implements SourcegraphSearchPort {
	async searchCode(query: string): Promise<readonly SourcegraphCodeCandidate[]> {
		return [
			{
				repository: "github.com/acme/widgets",
				path: `src/${query}.ts`,
				lineMatches: [{ line: 3, preview: "export function widget() {}" }],
				url: `https://sourcegraph.com/github.com/acme/widgets/-/blob/src/${query}.ts`,
			},
		];
	}
}

describe("lector CLI search github-repos/npm-packages/sourcegraph-code", () => {
	it("round-trips search github-repos through --json against the configured port", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createGithubSearch: () => new FakeGithubSearch(),
		});

		const result = JSON.parse(await runCli(["search", "github-repos", "widgets", "--json"])) as GithubRepoSearchResult;

		expect(result.candidates).toEqual([
			{
				host: "github.com",
				owner: "acme",
				repo: "widgets",
				description: "a widget factory",
				stars: 42,
				language: "TypeScript",
				url: "https://github.com/acme/widgets",
			},
		]);
		expect(result.authenticated).toBe(false);
	});

	it("renders a human-readable line and an unauthenticated note without --json", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createGithubSearch: () => new FakeGithubSearch(),
		});

		const output = await runCli(["search", "github-repos", "widgets"]);

		expect(output).toContain("acme/widgets");
		expect(output).toContain("42");
		expect(output.toLowerCase()).toContain("unauthenticated");
	});

	it("round-trips search npm-packages through --json against the configured registry", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createNpmRegistry: () => new FakeNpmRegistry(),
		});

		const result = JSON.parse(await runCli(["search", "npm-packages", "widgets", "--json"])) as { candidates: readonly NpmPackageCandidate[] };

		expect(result.candidates).toEqual([
			{ name: "widgets", version: "2.0.0", description: "a widget factory", repositoryUrl: "https://github.com/acme/widgets", score: 0.9 },
		]);
	});

	it("round-trips search sourcegraph-code through --json against the configured port", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createSourcegraphSearch: () => new FakeSourcegraphSearch(),
		});

		const result = JSON.parse(await runCli(["search", "sourcegraph-code", "widget", "--json"])) as { candidates: readonly SourcegraphCodeCandidate[] };

		expect(result.candidates).toEqual([
			{
				repository: "github.com/acme/widgets",
				path: "src/widget.ts",
				lineMatches: [{ line: 3, preview: "export function widget() {}" }],
				url: "https://sourcegraph.com/github.com/acme/widgets/-/blob/src/widget.ts",
			},
		]);
	});

	it("respects --max-results, forwarding it to the configured port", async () => {
		isolated = isolatedLectorPaths();
		let observedMaxResults: number | undefined;
		const port: GithubSearchPort = {
			async searchRepos(_query, bounds) {
				observedMaxResults = bounds.maxResults;
				return { candidates: [], authenticated: false };
			},
		};
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths, createGithubSearch: () => port });

		await runCli(["search", "github-repos", "widgets", "--max-results", "5", "--json"]);

		expect(observedMaxResults).toBe(5);
	});
});
