import { afterAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { SourcegraphSearchClient } from "../../src/sourcegraph-search/sourcegraph-search-client.ts";

const servers: Server<unknown>[] = [];

function hangingSearchServer(): string {
	const encoder = new TextEncoder();
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode('event: matches\ndata: [{"type":"content","repository":"github.com/a/one","path":"a.ts","lineMatches":[]}]\n\n'));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

afterAll(() => {
	for (const server of servers) server.stop(true);
});

describe("Sourcegraph partial-result latency", () => {
	it("finishes before the deadline-only control", async () => {
		const bounds = { maxResults: 10, timeoutMs: 200, maxResponseBytes: 10_000, maxRetries: 0 };
		const control = new SourcegraphSearchClient({ baseUrl: hangingSearchServer(), partialResultGraceMs: bounds.timeoutMs });
		const candidate = new SourcegraphSearchClient({ baseUrl: hangingSearchServer(), partialResultGraceMs: 20 });

		const controlStartedAt = performance.now();
		const controlResult = await control.searchCode("widget", bounds);
		const controlMs = performance.now() - controlStartedAt;
		const candidateStartedAt = performance.now();
		const candidateResult = await candidate.searchCode("widget", bounds);
		const candidateMs = performance.now() - candidateStartedAt;

		expect(candidateResult.candidates).toEqual(controlResult.candidates);
		expect(candidateResult.stopReason).toBe("deadline");
		expect(candidateMs).toBeLessThan(controlMs / 2);
	});
});
