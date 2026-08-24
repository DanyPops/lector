import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import {
	CratesIoAuthenticationRequired,
	CratesIoCrateNotFound,
	CratesIoRegistryClient,
	CratesIoRegistryResponseLimitExceeded,
	CratesIoVersionNotFound,
} from "../../src/crates-io-registry/crates-io-registry-client.ts";

const BOUNDS = { maxResponseBytes: 1_000_000, maxRedirects: 3, maxRetries: 0, timeoutMs: 5000 };

let server: Server<unknown> | undefined;

afterEach(() => {
	server?.stop(true);
	server = undefined;
});

function fixture(handler: (path: string, request: Request) => Response): string {
	server = Bun.serve({ port: 0, fetch: (request) => handler(new URL(request.url).pathname, request) });
	return server.url.toString();
}

describe("CratesIoRegistryClient", () => {
	it("maps a real crate-level response to its own repository and per-version yanked status", async () => {
		const registryUrl = fixture((path) => {
			if (path === "/api/v1/crates/widget") {
				return Response.json({
					crate: { name: "widget", repository: "https://github.com/acme/widget" },
					versions: [{ num: "1.2.3", yanked: false }],
				});
			}
			return new Response("missing", { status: 404 });
		});

		const metadata = await new CratesIoRegistryClient().fetchVersion({ registryUrl, registryName: null, name: "widget", version: "1.2.3" }, BOUNDS);

		expect(metadata).toEqual({ name: "widget", version: "1.2.3", yanked: false, repository: "https://github.com/acme/widget" });
	});

	it("surfaces a real yanked version rather than treating it as an error", async () => {
		const registryUrl = fixture(() => Response.json({ crate: { name: "widget", repository: null }, versions: [{ num: "1.0.0", yanked: true }] }));
		const metadata = await new CratesIoRegistryClient().fetchVersion({ registryUrl, registryName: null, name: "widget", version: "1.0.0" }, BOUNDS);
		expect(metadata.yanked).toBe(true);
	});

	it("throws CratesIoCrateNotFound for a real 404 on the crate-level endpoint", async () => {
		const registryUrl = fixture(() => new Response("not found", { status: 404 }));
		await expect(
			new CratesIoRegistryClient().fetchVersion({ registryUrl, registryName: null, name: "does-not-exist", version: "1.0.0" }, BOUNDS),
		).rejects.toBeInstanceOf(CratesIoCrateNotFound);
	});

	it("throws CratesIoVersionNotFound when the crate exists but the version is not in its own list", async () => {
		const registryUrl = fixture(() => Response.json({ crate: { name: "widget", repository: null }, versions: [{ num: "1.0.0", yanked: false }] }));
		await expect(
			new CratesIoRegistryClient().fetchVersion({ registryUrl, registryName: null, name: "widget", version: "9.9.9" }, BOUNDS),
		).rejects.toBeInstanceOf(CratesIoVersionNotFound);
	});

	it("throws CratesIoRegistryResponseLimitExceeded when the response exceeds the byte bound", async () => {
		const registryUrl = fixture(() => Response.json({ crate: { name: "widget", repository: null }, versions: [{ num: "1.0.0", yanked: false }] }));
		await expect(
			new CratesIoRegistryClient().fetchVersion({ registryUrl, registryName: null, name: "widget", version: "1.0.0" }, { ...BOUNDS, maxResponseBytes: 8 }),
		).rejects.toBeInstanceOf(CratesIoRegistryResponseLimitExceeded);
	});

	it("attaches a per-registry-named auth token from CARGO_REGISTRIES_<NAME>_TOKEN, never for crates.io itself", async () => {
		let sawAuthorization = "";
		const registryUrl = fixture((_path, request) => {
			sawAuthorization = request.headers.get("authorization") ?? "";
			return Response.json({ crate: { name: "internal-crate", repository: null }, versions: [{ num: "0.3.0", yanked: false }] });
		});
		process.env.CARGO_REGISTRIES_INTERNAL_TOKEN = "secret-token";
		try {
			await new CratesIoRegistryClient().fetchVersion({ registryUrl, registryName: "internal", name: "internal-crate", version: "0.3.0" }, BOUNDS);
		} finally {
			delete process.env.CARGO_REGISTRIES_INTERNAL_TOKEN;
		}
		expect(sawAuthorization).toBe("secret-token");
	});

	it("throws CratesIoAuthenticationRequired for a real 401/403 with no configured token", async () => {
		const registryUrl = fixture(() => new Response("forbidden", { status: 403 }));
		await expect(
			new CratesIoRegistryClient().fetchVersion({ registryUrl, registryName: "internal", name: "internal-crate", version: "0.3.0" }, BOUNDS),
		).rejects.toBeInstanceOf(CratesIoAuthenticationRequired);
	});
});
