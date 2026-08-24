import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import {
	PypiPackageNotFound,
	PypiRegistryAuthenticationRequired,
	PypiRegistryClient,
	PypiRegistryRequestFailed,
	PypiRegistryResponseLimitExceeded,
	PypiVersionNotFound,
} from "../../src/pypi-registry/pypi-registry-client.ts";

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
	return { info: { name: "requests", version: "2.31.0", project_urls: { Source: "https://github.com/psf/requests" }, ...overrides } };
}

describe("PypiRegistryClient", () => {
	it("requests the exact-version JSON endpoint and authenticates without returning the token", async () => {
		let observedPath = "";
		let observedAuthorization: string | null = null;
		const registry = serve((request) => {
			const url = new URL(request.url);
			observedPath = url.pathname;
			observedAuthorization = request.headers.get("authorization");
			return Response.json(metadata());
		});
		const client = new PypiRegistryClient({ token: () => TOKEN });

		const result = await client.fetchVersion({ registry, name: "requests", version: "2.31.0" }, BOUNDS);

		expect(result).toEqual({ name: "requests", version: "2.31.0", projectUrls: { Source: "https://github.com/psf/requests" } });
		expect(observedPath).toBe("/pypi/requests/2.31.0/json");
		expect(observedAuthorization as string | null).toBe(`Bearer ${TOKEN}`);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("defaults a missing project_urls to null rather than throwing", async () => {
		const registry = serve(() => Response.json({ info: { name: "bare", version: "1.0.0", project_urls: null } }));
		const client = new PypiRegistryClient();

		const result = await client.fetchVersion({ registry, name: "bare", version: "1.0.0" }, BOUNDS);

		expect(result).toEqual({ name: "bare", version: "1.0.0", projectUrls: null });
	});

	it("bounds the cumulative decoded response body", async () => {
		const registry = serve(() => Response.json(metadata({ padding: "x".repeat(2_000) })));
		const client = new PypiRegistryClient();

		await expect(client.fetchVersion({ registry, name: "requests", version: "2.31.0" }, { ...BOUNDS, maxResponseBytes: 100 })).rejects.toEqual(
			expect.objectContaining({ name: PypiRegistryResponseLimitExceeded.name, limit: 100 }),
		);
	});

	it("retries bounded transient failures and then succeeds", async () => {
		let attempts = 0;
		const registry = serve(() => {
			attempts++;
			return attempts < 3 ? new Response("temporary", { status: 503 }) : Response.json(metadata());
		});
		const client = new PypiRegistryClient();

		const result = await client.fetchVersion({ registry, name: "requests", version: "2.31.0" }, BOUNDS);

		expect(result.version).toBe("2.31.0");
		expect(attempts).toBe(3);
	});

	it("bounds redirect chains", async () => {
		const registry = serve((request) => Response.redirect(request.url, 302));
		const client = new PypiRegistryClient();

		await expect(client.fetchVersion({ registry, name: "requests", version: "2.31.0" }, { ...BOUNDS, maxRedirects: 1 })).rejects.toBeInstanceOf(
			PypiRegistryRequestFailed,
		);
	});

	it("times out a hanging registry request", async () => {
		const registry = serve(async () => {
			await Bun.sleep(100);
			return Response.json(metadata());
		});
		const client = new PypiRegistryClient();

		await expect(client.fetchVersion({ registry, name: "requests", version: "2.31.0" }, { ...BOUNDS, timeoutMs: 10 })).rejects.toEqual(
			expect.objectContaining({ name: PypiRegistryRequestFailed.name, code: "timeout" }),
		);
	});

	it("reports authentication requirements by credential name only", async () => {
		const registry = serve(() => new Response("denied", { status: 401 }));
		const client = new PypiRegistryClient({ token: () => TOKEN });

		let caught: unknown;
		try {
			await client.fetchVersion({ registry, name: "requests", version: "2.31.0" }, BOUNDS);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PypiRegistryAuthenticationRequired);
		expect(caught).toEqual(expect.objectContaining({ requiredCredentialNames: ["PYPI_TOKEN"] }));
		expect(String(caught)).not.toContain(TOKEN);
	});

	it("distinguishes a missing package from a missing exact version", async () => {
		let packageExists = false;
		const registry = serve((request) => {
			const path = new URL(request.url).pathname;
			if (path === "/pypi/requests/json")
				return packageExists ? Response.json({ info: { name: "requests" }, releases: {} }) : new Response("missing", { status: 404 });
			return new Response("missing", { status: 404 });
		});
		const client = new PypiRegistryClient();

		await expect(client.fetchVersion({ registry, name: "requests", version: "2.31.0" }, BOUNDS)).rejects.toBeInstanceOf(PypiPackageNotFound);
		packageExists = true;
		await expect(client.fetchVersion({ registry, name: "requests", version: "2.31.0" }, BOUNDS)).rejects.toBeInstanceOf(PypiVersionNotFound);
	});

	it("strips registry authorization when a redirect crosses origins", async () => {
		let redirectedAuthorization: string | null = "not-requested";
		const target = serve((request) => {
			redirectedAuthorization = request.headers.get("authorization");
			return Response.json(metadata());
		});
		const registry = serve(() => Response.redirect(`${target}/pypi/requests/2.31.0/json`, 302));
		const client = new PypiRegistryClient({ token: () => TOKEN });

		await client.fetchVersion({ registry, name: "requests", version: "2.31.0" }, BOUNDS);

		expect(redirectedAuthorization).toBeNull();
	});
});
