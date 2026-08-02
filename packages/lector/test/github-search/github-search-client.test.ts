import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import {
	GithubSearchClient,
	GithubSearchRateLimited,
	GithubSearchRequestFailed,
	GithubSearchResponseLimitExceeded,
	InvalidGithubSearchRequest,
} from "../../src/github-search/github-search-client.ts";

const BOUNDS = { maxResults: 20, timeoutMs: 2_000, maxResponseBytes: 65_536, maxRetries: 2 } as const;
const servers: Server<unknown>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function serve(fetch: (request: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ port: 0, fetch });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

function repoItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		full_name: "acme/widgets",
		name: "widgets",
		owner: { login: "acme" },
		description: "a widget factory",
		stargazers_count: 42,
		language: "TypeScript",
		html_url: "https://github.com/acme/widgets",
		...overrides,
	};
}

describe("GithubSearchClient", () => {
	it("requests repositories/search with the query and per_page, authenticating when a token is configured", async () => {
		let observedPath = "";
		let observedQuery = "";
		let observedAuthorization: string | null = null;
		const baseUrl = serve((request) => {
			const url = new URL(request.url);
			observedPath = url.pathname;
			observedQuery = url.search;
			observedAuthorization = request.headers.get("authorization");
			return Response.json({ total_count: 1, incomplete_results: false, items: [repoItem()] });
		});
		const client = new GithubSearchClient({ baseUrl, token: () => "gh-secret" });

		const result = await client.searchRepos("widgets", BOUNDS);

		expect(observedPath).toBe("/search/repositories");
		expect(observedQuery).toBe("?q=widgets&per_page=20");
		expect(observedAuthorization as string | null).toBe("Bearer gh-secret");
		expect(result.authenticated).toBe(true);
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
		expect(JSON.stringify(result)).not.toContain("gh-secret");
	});

	it("reports unauthenticated when no token is configured", async () => {
		const baseUrl = serve(() => Response.json({ total_count: 0, incomplete_results: false, items: [] }));
		const client = new GithubSearchClient({ baseUrl, token: () => undefined });

		const result = await client.searchRepos("widgets", BOUNDS);

		expect(result.authenticated).toBe(false);
	});

	it("maps a rate-limited 403 with a reset header into a typed error carrying retryAfterSeconds", async () => {
		const resetAt = Math.floor(Date.now() / 1000) + 42;
		const baseUrl = serve(
			() =>
				new Response("rate limit exceeded", {
					status: 403,
					headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) },
				}),
		);
		const client = new GithubSearchClient({ baseUrl, token: () => undefined });

		let caught: unknown;
		try {
			await client.searchRepos("widgets", BOUNDS);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(GithubSearchRateLimited);
		expect((caught as GithubSearchRateLimited).retryAfterSeconds).toBeGreaterThan(0);
		expect((caught as GithubSearchRateLimited).retryAfterSeconds).toBeLessThanOrEqual(42);
	});

	it("maps a 429 with a retry-after header into the same typed rate-limit error", async () => {
		const baseUrl = serve(() => new Response("secondary rate limit", { status: 429, headers: { "retry-after": "7" } }));
		const client = new GithubSearchClient({ baseUrl, token: () => undefined });

		let caught: unknown;
		try {
			await client.searchRepos("widgets", BOUNDS);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(GithubSearchRateLimited);
		expect((caught as GithubSearchRateLimited).retryAfterSeconds).toBe(7);
	});

	it("bounds the response body", async () => {
		const baseUrl = serve(() => Response.json({ total_count: 1, incomplete_results: false, items: [repoItem({ description: "x".repeat(2_000) })] }));
		const client = new GithubSearchClient({ baseUrl, token: () => undefined });

		await expect(client.searchRepos("widgets", { ...BOUNDS, maxResponseBytes: 100 })).rejects.toBeInstanceOf(GithubSearchResponseLimitExceeded);
	});

	it("rejects an empty query without making a request", async () => {
		const client = new GithubSearchClient({ baseUrl: "http://127.0.0.1:1", token: () => undefined });
		await expect(client.searchRepos("", BOUNDS)).rejects.toBeInstanceOf(InvalidGithubSearchRequest);
	});

	it("retries a bounded transient failure and then succeeds", async () => {
		let attempts = 0;
		const baseUrl = serve(() => {
			attempts++;
			return attempts < 2 ? new Response("temporary", { status: 503 }) : Response.json({ total_count: 0, incomplete_results: false, items: [] });
		});
		const client = new GithubSearchClient({ baseUrl, token: () => undefined });

		const result = await client.searchRepos("widgets", BOUNDS);

		expect(result.candidates).toEqual([]);
		expect(attempts).toBe(2);
	});

	it("times out a hanging request", async () => {
		const baseUrl = serve(async () => {
			await Bun.sleep(100);
			return Response.json({ total_count: 0, incomplete_results: false, items: [] });
		});
		const client = new GithubSearchClient({ baseUrl, token: () => undefined });

		await expect(client.searchRepos("widgets", { ...BOUNDS, timeoutMs: 10 })).rejects.toBeInstanceOf(GithubSearchRequestFailed);
	});
});
