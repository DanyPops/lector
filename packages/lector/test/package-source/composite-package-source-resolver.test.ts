import { describe, expect, it } from "bun:test";
import { CompositePackageSourceResolver } from "../../src/package-source/composite-package-source-resolver.ts";
import type { PackageSourceBounds, PackageSourceOutcome, PackageSourceRequest } from "../../src/package-source/package-source.ts";
import type { PackageSourceResolverPort } from "../../src/package-source/resolver-port.ts";

const BOUNDS: PackageSourceBounds = {
	maxManifestBytes: 1,
	maxManifestEntries: 1,
	maxManifestNesting: 1,
	maxWorkspaces: 1,
	maxDiagnostics: 1,
	maxRegistryResponseBytes: 1,
	maxRedirects: 1,
	maxRetries: 1,
	maxCloneBytes: 1,
	maxCacheBytes: 1,
	maxCandidates: 1,
	timeoutMs: 1,
};

function fakeResolver(ecosystem: string, outcome: PackageSourceOutcome): PackageSourceResolverPort {
	return {
		resolve: (request: PackageSourceRequest) =>
			Promise.resolve(request.coordinate.ecosystem === ecosystem ? outcome : { status: "unavailable", code: "unsupported-ecosystem" }),
	};
}

function request(ecosystem: PackageSourceRequest["coordinate"]["ecosystem"]): PackageSourceRequest {
	return { projectRoot: "/tmp/project", coordinate: { ecosystem, registry: null, name: "widget", requestedVersion: null } };
}

describe("CompositePackageSourceResolver", () => {
	it("dispatches to the one real resolver that actually supports the request's ecosystem", async () => {
		const npm = fakeResolver("npm", { status: "unavailable", code: "package-not-found" });
		const pypi = fakeResolver("pypi", { status: "unavailable", code: "version-not-found" });
		const composite = new CompositePackageSourceResolver([npm, pypi]);

		expect(await composite.resolve(request("npm"), BOUNDS)).toEqual({ status: "unavailable", code: "package-not-found" });
		expect(await composite.resolve(request("pypi"), BOUNDS)).toEqual({ status: "unavailable", code: "version-not-found" });
	});

	it("returns unsupported-ecosystem when no configured resolver supports the request's ecosystem", async () => {
		const composite = new CompositePackageSourceResolver([fakeResolver("npm", { status: "unavailable", code: "package-not-found" })]);

		expect(await composite.resolve(request("cargo"), BOUNDS)).toEqual({ status: "unavailable", code: "unsupported-ecosystem" });
	});

	it("tries the next resolver when an earlier one reports unsupported-ecosystem, rather than stopping at the first", async () => {
		const first = fakeResolver("npm", { status: "unavailable", code: "package-not-found" });
		const second = fakeResolver("pypi", { status: "unavailable", code: "version-not-found" });
		const composite = new CompositePackageSourceResolver([first, second]);

		expect(await composite.resolve(request("pypi"), BOUNDS)).toEqual({ status: "unavailable", code: "version-not-found" });
	});
});
