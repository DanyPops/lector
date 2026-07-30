import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import {
	BoundedResponseTooLarge,
	discardResponseBody,
	isJsonRecord,
	MalformedBoundedResponse,
	readBoundedJson,
} from "../../src/adapters/bounded-response-reader.ts";

const GENEROUS_LIMIT_BYTES = 1024;
const TIGHT_LIMIT_BYTES = 100;
const OVERSIZED_BODY_PADDING_LENGTH = 2_000;
const SHARED_BUDGET_LIMIT_BYTES = 200;
/** Large enough that two responses of this size together exceed SHARED_BUDGET_LIMIT_BYTES, small enough that one alone does not. */
const BUDGET_SHARING_PADDING_LENGTH = 150;

const servers: Server<unknown>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function serve(fetch: (request: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ port: 0, fetch });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

describe("isJsonRecord", () => {
	it("accepts a plain object, rejects arrays/null/primitives", () => {
		expect(isJsonRecord({})).toBe(true);
		expect(isJsonRecord([])).toBe(false);
		expect(isJsonRecord(null)).toBe(false);
		expect(isJsonRecord("x")).toBe(false);
	});
});

describe("readBoundedJson", () => {
	it("parses a well-formed JSON body under the limit", async () => {
		const url = serve(() => Response.json({ hello: "world" }));
		const response = await fetch(url);
		expect(await readBoundedJson(response, GENEROUS_LIMIT_BYTES)).toEqual({ hello: "world" });
	});

	it("rejects up front via Content-Length when the declared size exceeds the limit", async () => {
		const url = serve(() => Response.json({ padding: "x".repeat(OVERSIZED_BODY_PADDING_LENGTH) }));
		const response = await fetch(url);
		await expect(readBoundedJson(response, TIGHT_LIMIT_BYTES)).rejects.toBeInstanceOf(BoundedResponseTooLarge);
	});

	it("rejects mid-stream via cumulative bytes read when Content-Length is absent or understates size", async () => {
		const url = serve(
			() => new Response(JSON.stringify({ padding: "x".repeat(OVERSIZED_BODY_PADDING_LENGTH) }), { headers: { "transfer-encoding": "chunked" } }),
		);
		const response = await fetch(url);
		await expect(readBoundedJson(response, TIGHT_LIMIT_BYTES)).rejects.toBeInstanceOf(BoundedResponseTooLarge);
	});

	it("shares one cumulative budget across two sequential reads when a budget object is passed", async () => {
		const url = serve(() => Response.json({ padding: "x".repeat(BUDGET_SHARING_PADDING_LENGTH) }));
		const budget = { used: 0 };
		const first = await fetch(url);
		await readBoundedJson(first, SHARED_BUDGET_LIMIT_BYTES, budget);
		const second = await fetch(url);
		await expect(readBoundedJson(second, SHARED_BUDGET_LIMIT_BYTES, budget)).rejects.toBeInstanceOf(BoundedResponseTooLarge);
	});

	it("rejects an invalid JSON body as malformed", async () => {
		const url = serve(() => new Response("not json"));
		const response = await fetch(url);
		await expect(readBoundedJson(response, GENEROUS_LIMIT_BYTES)).rejects.toBeInstanceOf(MalformedBoundedResponse);
	});
});

describe("discardResponseBody", () => {
	it("does not throw for a response with no body", async () => {
		await expect(discardResponseBody(new Response(null, { status: 204 }))).resolves.toBeUndefined();
	});
});
