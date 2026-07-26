import { describe, expect, it } from "bun:test";
import type { PackageSourceOutcome, PackageSourceRequest } from "../../src/domain/package-source.ts";
import { InvalidPackageSourceContract, resolvePackageSource } from "../../src/domain/resolve-package-source.ts";
import type { PackageSourceResolverPort } from "../../src/ports/package-source-resolver-port.ts";
import { PACKAGE_SOURCE_OUTCOME_FIXTURES, VERIFIED_NPM_SOURCE } from "../support/package-source-outcome-fixtures.ts";

const REQUEST: PackageSourceRequest = {
	projectRoot: "/workspace",
	coordinate: { ecosystem: "npm", registry: "https://registry.npmjs.org", name: "@fixture/dependency", requestedVersion: "1.2.3" },
};

const BOUNDS = {
	maxManifestBytes: 1_000_000,
	maxManifestEntries: 10_000,
	maxRegistryResponseBytes: 2_000_000,
	maxRedirects: 3,
	maxRetries: 2,
	maxCloneBytes: 100_000_000,
	maxCacheBytes: 1_000_000_000,
	maxCandidates: 20,
	timeoutMs: 30_000,
} as const;

class FixedResolver implements PackageSourceResolverPort {
	calls = 0;

	constructor(private readonly outcome: PackageSourceOutcome) {}

	resolve(): Promise<PackageSourceOutcome> {
		this.calls++;
		return Promise.resolve(this.outcome);
	}
}

describe("resolvePackageSource", () => {
	it("passes every machine-distinct contract fixture through unchanged", async () => {
		for (const outcome of PACKAGE_SOURCE_OUTCOME_FIXTURES) {
			expect(await resolvePackageSource(new FixedResolver(outcome), REQUEST, BOUNDS)).toEqual(outcome);
		}
	});

	it("rejects an empty or control-character package coordinate before calling the adapter", async () => {
		for (const name of ["", "bad\u0000name"]) {
			const request = { ...REQUEST, coordinate: { ...REQUEST.coordinate, name } };
			const resolver = new FixedResolver(VERIFIED_NPM_SOURCE);
			await expect(resolvePackageSource(resolver, request, BOUNDS)).rejects.toBeInstanceOf(InvalidPackageSourceContract);
			expect(resolver.calls).toBe(0);
		}
	});

	it("rejects a non-positive resource bound before calling the adapter", async () => {
		const resolver = new FixedResolver(VERIFIED_NPM_SOURCE);
		await expect(resolvePackageSource(resolver, REQUEST, { ...BOUNDS, maxCloneBytes: 0 })).rejects.toBeInstanceOf(InvalidPackageSourceContract);
		expect(resolver.calls).toBe(0);
	});

	it("rejects an unknown runtime ecosystem before calling the adapter", async () => {
		const request = { ...REQUEST, coordinate: { ...REQUEST.coordinate, ecosystem: "ruby" } } as unknown as PackageSourceRequest;
		const resolver = new FixedResolver(VERIFIED_NPM_SOURCE);
		await expect(resolvePackageSource(resolver, request, BOUNDS)).rejects.toBeInstanceOf(InvalidPackageSourceContract);
		expect(resolver.calls).toBe(0);
	});

	it("rejects unknown runtime outcome discriminators and codes", async () => {
		for (const outcome of [
			{ status: "ready" },
			{ status: "unavailable", code: "anything" },
			{ ...VERIFIED_NPM_SOURCE, workspace: { ...VERIFIED_NPM_SOURCE.workspace, origin: "remote" } },
		] as unknown as PackageSourceOutcome[]) {
			await expect(resolvePackageSource(new FixedResolver(outcome), REQUEST, BOUNDS)).rejects.toBeInstanceOf(InvalidPackageSourceContract);
		}
	});

	it("rejects a fetched source without an exact commit", async () => {
		const outcome: PackageSourceOutcome = { ...VERIFIED_NPM_SOURCE, repository: { ...VERIFIED_NPM_SOURCE.repository, commit: null } };
		await expect(resolvePackageSource(new FixedResolver(outcome), REQUEST, BOUNDS)).rejects.toBeInstanceOf(InvalidPackageSourceContract);
	});

	it("rejects a writable returned workspace", async () => {
		const outcome = { ...VERIFIED_NPM_SOURCE, workspace: { ...VERIFIED_NPM_SOURCE.workspace, readOnly: false } } as unknown as PackageSourceOutcome;
		await expect(resolvePackageSource(new FixedResolver(outcome), REQUEST, BOUNDS)).rejects.toBeInstanceOf(InvalidPackageSourceContract);
	});

	it("rejects a verified result that silently fell back from the requested ref", async () => {
		const outcome: PackageSourceOutcome = {
			...VERIFIED_NPM_SOURCE,
			repository: { ...VERIFIED_NPM_SOURCE.repository, resolvedRef: "main" },
		};
		await expect(resolvePackageSource(new FixedResolver(outcome), REQUEST, BOUNDS)).rejects.toBeInstanceOf(InvalidPackageSourceContract);
	});

	it("accepts a read-only local source proven by content integrity without a repository commit", async () => {
		const outcome: PackageSourceOutcome = {
			...VERIFIED_NPM_SOURCE,
			repository: { url: null, requestedRef: null, resolvedRef: null, commit: null },
			workspace: { cachePath: "/workspace/packages/dependency", origin: "local", readOnly: true },
			verification: { status: "verified", method: "local-content-digest", integrity: "sha256-local-fixture" },
		};
		expect(await resolvePackageSource(new FixedResolver(outcome), REQUEST, BOUNDS)).toEqual(outcome);
	});

	it("rejects ambiguous candidates beyond the caller's bound", async () => {
		const outcome: PackageSourceOutcome = {
			status: "ambiguous",
			code: "multiple-source-candidates",
			candidates: Array.from({ length: BOUNDS.maxCandidates + 1 }, (_, index) => ({ version: `1.0.${index}`, source: "fixture" })),
			truncated: false,
		};
		await expect(resolvePackageSource(new FixedResolver(outcome), REQUEST, BOUNDS)).rejects.toBeInstanceOf(InvalidPackageSourceContract);
	});

	it("keeps unauthenticated output name-only", async () => {
		const result = await resolvePackageSource(
			new FixedResolver({ status: "unauthenticated", code: "repository-authentication-required", requiredCredentialNames: ["GITHUB_TOKEN"] }),
			REQUEST,
			BOUNDS,
		);
		expect(result).toEqual({ status: "unauthenticated", code: "repository-authentication-required", requiredCredentialNames: ["GITHUB_TOKEN"] });
	});
});
