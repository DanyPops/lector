import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import {
	InvalidSourcegraphSearchRequest,
	SourcegraphSearchClient,
	SourcegraphSearchRequestFailed,
	SourcegraphSearchResponseLimitExceeded,
} from "../../src/sourcegraph-search/sourcegraph-search-client.ts";

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

function sseResponse(events: readonly { event: string; data: unknown }[]): Response {
	const body = events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("SourcegraphSearchClient", () => {
	it("streams matches events and maps them into candidates", async () => {
		let observedPath = "";
		let observedQuery = "";
		let observedAccept: string | null = null;
		const baseUrl = serve((request) => {
			const url = new URL(request.url);
			observedPath = url.pathname;
			observedQuery = url.search;
			observedAccept = request.headers.get("accept");
			return sseResponse([
				{
					event: "matches",
					data: [
						{
							type: "content",
							repository: "github.com/acme/widgets",
							path: "src/widget.ts",
							lineMatches: [{ lineNumber: 9, line: "export function widget() {}" }],
						},
					],
				},
				{ event: "done", data: {} },
			]);
		});
		const client = new SourcegraphSearchClient({ baseUrl });

		const result = await client.searchCode("widget", BOUNDS);

		expect(observedPath).toBe("/.api/search/stream");
		expect(observedQuery).toBe("?q=widget");
		expect(observedAccept as string | null).toBe("text/event-stream");
		expect(result).toMatchObject({ completeness: "complete", truncated: false });
		expect(result.bytesRead).toBeGreaterThan(0);
		expect(result.candidates).toEqual([
			{
				repository: "github.com/acme/widgets",
				path: "src/widget.ts",
				lineMatches: [{ line: 9, preview: "export function widget() {}" }],
				url: "https://sourcegraph.com/github.com/acme/widgets/-/blob/src/widget.ts",
			},
		]);
	});

	it("stops collecting once maxResults is reached across multiple matches events", async () => {
		const baseUrl = serve(() =>
			sseResponse([
				{
					event: "matches",
					data: [
						{ type: "content", repository: "github.com/a/one", path: "a.ts", lineMatches: [] },
						{ type: "content", repository: "github.com/a/two", path: "b.ts", lineMatches: [] },
					],
				},
				{ event: "matches", data: [{ type: "content", repository: "github.com/a/three", path: "c.ts", lineMatches: [] }] },
				{ event: "done", data: {} },
			]),
		);
		const client = new SourcegraphSearchClient({ baseUrl });

		const result = await client.searchCode("widget", { ...BOUNDS, maxResults: 2 });

		expect(result.candidates.length).toBe(2);
		expect(result).toMatchObject({ completeness: "partial", truncated: true, stopReason: "max-results" });
	});

	it("ignores non-content match entries (e.g. a repository match) rather than throwing", async () => {
		const baseUrl = serve(() =>
			sseResponse([
				{ event: "matches", data: [{ type: "repo", repository: "github.com/a/one" }] },
				{ event: "done", data: {} },
			]),
		);
		const client = new SourcegraphSearchClient({ baseUrl });

		const result = await client.searchCode("widget", BOUNDS);

		expect(result.candidates).toEqual([]);
		expect(result).toMatchObject({ completeness: "complete", truncated: false });
	});

	it("surfaces an alert event as a typed request failure rather than returning partial results silently", async () => {
		const baseUrl = serve(() => sseResponse([{ event: "alert", data: { title: "query too broad" } }]));
		const client = new SourcegraphSearchClient({ baseUrl });

		await expect(client.searchCode("widget", BOUNDS)).rejects.toBeInstanceOf(SourcegraphSearchRequestFailed);
	});

	it("rejects a non-2xx response", async () => {
		const baseUrl = serve(() => new Response("bad gateway", { status: 502 }));
		const client = new SourcegraphSearchClient({ baseUrl });

		await expect(client.searchCode("widget", BOUNDS)).rejects.toBeInstanceOf(SourcegraphSearchRequestFailed);
	});

	it("rejects an empty query without making a request", async () => {
		const client = new SourcegraphSearchClient({ baseUrl: "http://127.0.0.1:1" });
		await expect(client.searchCode("", BOUNDS)).rejects.toBeInstanceOf(InvalidSourcegraphSearchRequest);
	});

	it("bounds the cumulative stream size", async () => {
		const baseUrl = serve(() =>
			sseResponse([
				{ event: "matches", data: [{ type: "content", repository: "github.com/a/one", path: "a.ts", lineMatches: [], padding: "x".repeat(2_000) }] },
			]),
		);
		const client = new SourcegraphSearchClient({ baseUrl });

		await expect(client.searchCode("widget", { ...BOUNDS, maxResponseBytes: 100 })).rejects.toBeInstanceOf(SourcegraphSearchResponseLimitExceeded);
	});

	it("returns collected candidates when the deadline ends a hanging stream", async () => {
		const encoder = new TextEncoder();
		const baseUrl = serve(
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode('event: matches\ndata: [{"type":"content","repository":"github.com/a/one","path":"a.ts","lineMatches":[]}]\n\n'),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const client = new SourcegraphSearchClient({ baseUrl, partialResultGraceMs: 20 });
		const startedAt = performance.now();

		const result = await client.searchCode("widget", { ...BOUNDS, timeoutMs: 2_000 });

		expect(performance.now() - startedAt).toBeLessThan(500);
		expect(result.candidates).toHaveLength(1);
		expect(result).toMatchObject({ completeness: "partial", truncated: true, stopReason: "deadline" });
	});

	it("reports a timeout when the deadline yields no candidates", async () => {
		const baseUrl = serve(async () => {
			await Bun.sleep(200);
			return sseResponse([{ event: "done", data: {} }]);
		});
		const client = new SourcegraphSearchClient({ baseUrl });

		await expect(client.searchCode("widget", { ...BOUNDS, timeoutMs: 10 })).rejects.toBeInstanceOf(SourcegraphSearchRequestFailed);
	});
});
