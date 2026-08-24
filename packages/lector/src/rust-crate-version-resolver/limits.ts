import type { InstalledCrateVersionBounds, InstalledCrateVersionOutcome, OversizedInstalledCrateVersion } from "./installed-crate.ts";

export type LimitedResource = OversizedInstalledCrateVersion["resource"];

export const HARD_MAX_MANIFEST_BYTES = 256 * 1024 * 1024;
export const HARD_MAX_MANIFEST_ENTRIES = 5_000_000;
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

export function resourceLimitOutcome(error: ManifestResourceLimitExceeded, bounds: InstalledCrateVersionBounds): InstalledCrateVersionOutcome {
	const limits: Record<LimitedResource, number> = {
		"manifest-bytes": bounds.maxManifestBytes,
		"manifest-entries": bounds.maxManifestEntries,
		diagnostics: bounds.maxDiagnostics,
	};
	return { status: "oversized", resource: error.resource, limit: limits[error.resource] };
}
