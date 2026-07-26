import type { PackageSourceOutcome, VerifiedPackageSource } from "../../src/domain/package-source.ts";

export const VERIFIED_NPM_SOURCE: VerifiedPackageSource = {
	status: "verified",
	coordinate: {
		ecosystem: "npm",
		registry: "https://registry.npmjs.org",
		name: "@fixture/dependency",
		requestedVersion: "1.2.3",
		resolvedVersion: "1.2.3",
	},
	repository: {
		url: "https://github.com/fixture/dependency.git",
		requestedRef: "v1.2.3",
		resolvedRef: "v1.2.3",
		commit: "1111111111111111111111111111111111111111",
	},
	workspace: {
		cachePath: "/cache/npm/fixture-dependency/1.2.3",
		origin: "fetched",
		readOnly: true,
	},
	verification: {
		status: "verified",
		method: "registry-metadata-and-commit",
		integrity: "sha512-fixture123",
	},
};

export const PACKAGE_SOURCE_OUTCOME_FIXTURES: readonly PackageSourceOutcome[] = [
	VERIFIED_NPM_SOURCE,
	{ status: "unavailable", code: "source-metadata-missing" },
	{
		status: "ambiguous",
		code: "multiple-installed-versions",
		candidates: [
			{ version: "1.2.3", source: "locks/npm/package-lock.json" },
			{ version: "2.0.0", source: "locks/npm/package-lock.json" },
		],
		truncated: false,
	},
	{ status: "unauthenticated", code: "registry-authentication-required", requiredCredentialNames: ["NPM_TOKEN"] },
	{ status: "oversized", code: "manifest-limit-exceeded", resource: "manifest-bytes", limit: 1024, observed: 2048 },
	{
		status: "mismatched",
		code: "repository-commit-mismatch",
		expected: "1111111111111111111111111111111111111111",
		actual: "2222222222222222222222222222222222222222",
	},
];
