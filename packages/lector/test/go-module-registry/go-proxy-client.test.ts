import { describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { GoProxyClient, GoProxyRequestFailed, GoProxyResponseLimitExceeded, GoProxyVersionNotFound } from "../../src/go-module-registry/go-proxy-client.ts";

const BOUNDS = { maxResponseBytes: 64 * 1024, maxRetries: 0, timeoutMs: 2000 };

function startFixture(handle: (path: string) => Response): Server<unknown> {
	return Bun.serve({ port: 0, fetch: (request) => handle(new URL(request.url).pathname) });
}

describe("GoProxyClient", () => {
	it("confirms a real published version exists via the @v/<version>.info endpoint", async () => {
		const server = startFixture((path) => {
			if (path === "/example.com/fixturedep/@v/v1.2.3.info") {
				return new Response(JSON.stringify({ Version: "v1.2.3", Time: "2024-01-02T03:04:05Z" }), { headers: { "content-type": "application/json" } });
			}
			return new Response("not found", { status: 404 });
		});
		try {
			const client = new GoProxyClient();
			const info = await client.fetchVersionInfo({ proxyUrl: server.url.toString(), modulePath: "example.com/fixturedep", version: "v1.2.3" }, BOUNDS);
			expect(info.version).toBe("v1.2.3");
		} finally {
			server.stop(true);
		}
	});

	it("escapes an uppercase module path before requesting it", async () => {
		let requestedPath = "";
		const server = startFixture((path) => {
			requestedPath = path;
			return new Response(JSON.stringify({ Version: "v1.0.0", Time: "2024-01-01T00:00:00Z" }), { headers: { "content-type": "application/json" } });
		});
		try {
			const client = new GoProxyClient();
			await client.fetchVersionInfo({ proxyUrl: server.url.toString(), modulePath: "github.com/BurntSushi/toml", version: "v1.0.0" }, BOUNDS);
			expect(requestedPath).toBe("/github.com/!burnt!sushi/toml/@v/v1.0.0.info");
		} finally {
			server.stop(true);
		}
	});

	it("throws GoProxyVersionNotFound for a real 404 response", async () => {
		const server = startFixture(() => new Response("not found", { status: 404 }));
		try {
			const client = new GoProxyClient();
			await expect(
				client.fetchVersionInfo({ proxyUrl: server.url.toString(), modulePath: "example.com/fixturedep", version: "v9.9.9" }, BOUNDS),
			).rejects.toBeInstanceOf(GoProxyVersionNotFound);
		} finally {
			server.stop(true);
		}
	});

	it("throws GoProxyResponseLimitExceeded when the response exceeds the byte bound", async () => {
		const server = startFixture(() => new Response("x".repeat(1024), { headers: { "content-type": "application/json" } }));
		try {
			const client = new GoProxyClient();
			await expect(
				client.fetchVersionInfo(
					{ proxyUrl: server.url.toString(), modulePath: "example.com/fixturedep", version: "v1.2.3" },
					{ ...BOUNDS, maxResponseBytes: 16 },
				),
			).rejects.toBeInstanceOf(GoProxyResponseLimitExceeded);
		} finally {
			server.stop(true);
		}
	});

	it("throws GoProxyRequestFailed for a real server error", async () => {
		const server = startFixture(() => new Response("boom", { status: 500 }));
		try {
			const client = new GoProxyClient();
			await expect(
				client.fetchVersionInfo({ proxyUrl: server.url.toString(), modulePath: "example.com/fixturedep", version: "v1.2.3" }, BOUNDS),
			).rejects.toBeInstanceOf(GoProxyRequestFailed);
		} finally {
			server.stop(true);
		}
	});
});
