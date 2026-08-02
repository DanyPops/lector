import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import {
	NpmPackageNotFound,
	NpmRegistryAuthenticationRequired,
	NpmRegistryClient,
	NpmRegistryRequestFailed,
	NpmRegistryResponseLimitExceeded,
	NpmVersionNotFound,
} from "../../src/npm-registry/npm-registry-client.ts";

const BOUNDS = { maxResponseBytes: 16_384, maxRedirects: 3, maxRetries: 2, timeoutMs: 2_000 } as const;
const TOKEN = "registry-secret-that-must-not-escape";
const servers: Server<unknown>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function serve(fetch: (request: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ port: 0, fetch });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "@scope/widget",
		version: "1.2.3",
		repository: { type: "git", url: "git+https://github.com/acme/widgets.git", directory: "packages/widget" },
		gitHead: "1111111111111111111111111111111111111111",
		dist: { integrity: "sha512-fixture" },
		...overrides,
	};
}

describe("NpmRegistryClient", () => {
	it("requests an encoded scoped package version and authenticates without returning the token", async () => {
		let observedPath = "";
		let observedAuthorization: string | null = null;
		const registry = serve((request) => {
			const url = new URL(request.url);
			observedPath = url.pathname;
			observedAuthorization = request.headers.get("authorization");
			return Response.json(metadata());
		});
		const client = new NpmRegistryClient({ token: () => TOKEN });

		const result = await client.fetchVersion({ registry, name: "@scope/widget", version: "1.2.3" }, BOUNDS);

		expect(result.name).toBe("@scope/widget");
		expect(observedPath.toLowerCase()).toBe("/%40scope%2fwidget/1.2.3");
		expect(observedAuthorization as string | null).toBe(`Bearer ${TOKEN}`);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("bounds the cumulative decoded response body", async () => {
		const registry = serve(() => Response.json(metadata({ padding: "x".repeat(2_000) })));
		const client = new NpmRegistryClient();

		await expect(client.fetchVersion({ registry, name: "@scope/widget", version: "1.2.3" }, { ...BOUNDS, maxResponseBytes: 100 })).rejects.toEqual(
			expect.objectContaining({ name: NpmRegistryResponseLimitExceeded.name, limit: 100 }),
		);
	});

	it("retries bounded transient failures and then succeeds", async () => {
		let attempts = 0;
		const registry = serve(() => {
			attempts++;
			return attempts < 3 ? new Response("temporary", { status: 503 }) : Response.json(metadata());
		});
		const client = new NpmRegistryClient();

		const result = await client.fetchVersion({ registry, name: "@scope/widget", version: "1.2.3" }, BOUNDS);

		expect(result.version).toBe("1.2.3");
		expect(attempts).toBe(3);
	});

	it("bounds redirect chains", async () => {
		const registry = serve((request) => Response.redirect(request.url, 302));
		const client = new NpmRegistryClient();

		await expect(client.fetchVersion({ registry, name: "@scope/widget", version: "1.2.3" }, { ...BOUNDS, maxRedirects: 1 })).rejects.toBeInstanceOf(
			NpmRegistryRequestFailed,
		);
	});

	it("times out a hanging registry request", async () => {
		const registry = serve(async () => {
			await Bun.sleep(100);
			return Response.json(metadata());
		});
		const client = new NpmRegistryClient();

		await expect(client.fetchVersion({ registry, name: "@scope/widget", version: "1.2.3" }, { ...BOUNDS, timeoutMs: 10 })).rejects.toEqual(
			expect.objectContaining({ name: NpmRegistryRequestFailed.name, code: "timeout" }),
		);
	});

	it("reports authentication requirements by credential name only", async () => {
		const registry = serve(() => new Response("denied", { status: 401 }));
		const client = new NpmRegistryClient({ token: () => TOKEN });

		let caught: unknown;
		try {
			await client.fetchVersion({ registry, name: "@scope/widget", version: "1.2.3" }, BOUNDS);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(NpmRegistryAuthenticationRequired);
		expect(caught).toEqual(expect.objectContaining({ requiredCredentialNames: ["NPM_TOKEN"] }));
		expect(String(caught)).not.toContain(TOKEN);
	});

	it("searches by text and maps results into candidates shaped for package.resolveSource", async () => {
		let observedPath = "";
		let observedQuery = "";
		const registry = serve((request) => {
			const url = new URL(request.url);
			observedPath = url.pathname;
			observedQuery = url.search;
			return Response.json({
				objects: [
					{
						package: { name: "widgets", version: "2.0.0", description: "a widget factory", links: { repository: "https://github.com/acme/widgets" } },
						score: { final: 0.87 },
					},
				],
				total: 1,
			});
		});
		const client = new NpmRegistryClient({ searchRegistry: registry });

		const candidates = await client.search("widgets", { maxResults: 20, timeoutMs: 2_000, maxResponseBytes: 16_384, maxRetries: 2 });

		expect(observedPath).toBe("/-/v1/search");
		expect(observedQuery).toBe("?text=widgets&size=20");
		expect(candidates).toEqual([
			{ name: "widgets", version: "2.0.0", description: "a widget factory", repositoryUrl: "https://github.com/acme/widgets", score: 0.87 },
		]);
	});

	it("defaults a missing description/repository to null rather than throwing", async () => {
		const registry = serve(() => Response.json({ objects: [{ package: { name: "bare", version: "1.0.0" }, score: { final: 0.5 } }] }));
		const client = new NpmRegistryClient({ searchRegistry: registry });

		const candidates = await client.search("bare", { maxResults: 10, timeoutMs: 2_000, maxResponseBytes: 16_384, maxRetries: 2 });

		expect(candidates).toEqual([{ name: "bare", version: "1.0.0", description: null, repositoryUrl: null, score: 0.5 }]);
	});

	it("bounds the search response body the same way fetchVersion does", async () => {
		const registry = serve(() => Response.json({ objects: [{ package: { name: "x".repeat(2_000), version: "1.0.0" }, score: { final: 1 } }] }));
		const client = new NpmRegistryClient({ searchRegistry: registry });

		await expect(client.search("widgets", { maxResults: 10, timeoutMs: 2_000, maxResponseBytes: 100, maxRetries: 2 })).rejects.toBeInstanceOf(
			NpmRegistryResponseLimitExceeded,
		);
	});

	it("retries a bounded transient search failure and then succeeds", async () => {
		let attempts = 0;
		const registry = serve(() => {
			attempts++;
			return attempts < 2 ? new Response("temporary", { status: 503 }) : Response.json({ objects: [] });
		});
		const client = new NpmRegistryClient({ searchRegistry: registry });

		const candidates = await client.search("widgets", { maxResults: 10, timeoutMs: 2_000, maxResponseBytes: 16_384, maxRetries: 2 });

		expect(candidates).toEqual([]);
		expect(attempts).toBe(2);
	});

	it("strips registry authorization when a redirect crosses origins", async () => {
		let redirectedAuthorization: string | null = "not-requested";
		const target = serve((request) => {
			redirectedAuthorization = request.headers.get("authorization");
			return Response.json(metadata());
		});
		const registry = serve(() => Response.redirect(`${target}/%40scope%2fwidget/1.2.3`, 302));
		const client = new NpmRegistryClient({ token: () => TOKEN });

		await client.fetchVersion({ registry, name: "@scope/widget", version: "1.2.3" }, BOUNDS);

		expect(redirectedAuthorization).toBeNull();
	});

	it("distinguishes a missing package from a missing exact version", async () => {
		let packageExists = false;
		const registry = serve((request) => {
			const path = new URL(request.url).pathname.toLowerCase();
			if (path === "/%40scope%2fwidget")
				return packageExists ? Response.json({ name: "@scope/widget", versions: {} }) : new Response("missing", { status: 404 });
			return new Response("missing", { status: 404 });
		});
		const client = new NpmRegistryClient();

		await expect(client.fetchVersion({ registry, name: "@scope/widget", version: "1.2.3" }, BOUNDS)).rejects.toBeInstanceOf(NpmPackageNotFound);
		packageExists = true;
		await expect(client.fetchVersion({ registry, name: "@scope/widget", version: "1.2.3" }, BOUNDS)).rejects.toBeInstanceOf(NpmVersionNotFound);
	});
});
