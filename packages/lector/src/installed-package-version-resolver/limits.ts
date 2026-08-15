import type { InstalledPackageVersionBounds, InstalledPackageVersionOutcome, OversizedInstalledPackageVersion } from "./installed-package-version.ts";

export type LimitedResource = OversizedInstalledPackageVersion["resource"];

export const HARD_MAX_MANIFEST_BYTES = 256 * 1024 * 1024;
export const HARD_MAX_MANIFEST_ENTRIES = 5_000_000;
export const HARD_MAX_MANIFEST_NESTING = 512;
export const HARD_MAX_WORKSPACES = 100_000;
export const HARD_MAX_DIAGNOSTICS = 10_000;
export const HARD_MAX_CANDIDATES = 100_000;
export const HARD_MAX_EVIDENCE_PER_VERSION = 100_000;

export class ManifestResourceLimitExceeded extends Error {
	readonly resource: LimitedResource;

	constructor(resource: LimitedResource) {
		super(resource);
		this.resource = resource;
	}
}

export function resourceLimitOutcome(error: ManifestResourceLimitExceeded, bounds: InstalledPackageVersionBounds): InstalledPackageVersionOutcome {
	const limits: Record<LimitedResource, number> = {
		"manifest-bytes": bounds.maxManifestBytes,
		"manifest-entries": bounds.maxManifestEntries,
		"manifest-nesting": bounds.maxManifestNesting,
		workspaces: bounds.maxWorkspaces,
		diagnostics: bounds.maxDiagnostics,
	};
	return { status: "oversized", resource: error.resource, limit: limits[error.resource] };
}
