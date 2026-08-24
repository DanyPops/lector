export interface InstalledGoModuleVersionRequest {
	readonly projectRoot: string;
	readonly modulePath: string;
	readonly requestedVersion: string | null;
}

export interface InstalledGoModuleVersionBounds {
	readonly maxManifestBytes: number;
	readonly maxManifestEntries: number;
	readonly maxDiagnostics: number;
	readonly maxCandidates: number;
	readonly maxEvidencePerVersion: number;
	readonly maxWorkspaceModules: number;
}

/**
 * How this module's source is actually reachable -- a real distinction, not just provenance: a
 * "replace"d module has no meaningful registry version to verify against a tag guess at all (its
 * source, or lack of one, is already named directly by the replace directive), unlike a plain
 * "require" resolved the ordinary way.
 */
export type GoModuleInstallKind = "module-path" | "local-replace" | "vcs-replace";

export interface InstalledGoModuleEvidence {
	readonly manifest: string;
	/** The manifest's own locator text for this entry (a require/replace line, or a vendor/modules.txt module header) -- opaque, for diagnostics only. */
	readonly locator: string;
	readonly kind: GoModuleInstallKind;
	/** Present only for kind "vcs-replace"/"local-replace": the replacement's own module path or local filesystem path, independent of the original require path. */
	readonly directSource: string | null;
	/** Present when an exact commit is already known directly from the manifest (a pseudo-version's own embedded abbreviated commit, or a replace directive's explicit full commit hash) -- lets the source resolver skip an ambiguous ref guess entirely. */
	readonly commit: string | null;
	/** go.sum's own declared h1: hash for this module@version, when present -- absent (not mismatched) for a private/replaced module with no sumdb entry at all. */
	readonly checksum: string | null;
}

export interface ResolvedInstalledGoModuleVersion {
	readonly status: "resolved";
	readonly modulePath: string;
	readonly requestedVersion: string | null;
	readonly version: string;
	readonly evidence: readonly InstalledGoModuleEvidence[];
	readonly evidenceTruncated: boolean;
}

export interface InstalledGoModuleVersionCandidate {
	readonly version: string;
	readonly evidence: readonly InstalledGoModuleEvidence[];
	readonly evidenceTruncated: boolean;
}

export interface AmbiguousInstalledGoModuleVersion {
	readonly status: "ambiguous";
	readonly modulePath: string;
	readonly requestedVersion: null;
	readonly candidates: readonly InstalledGoModuleVersionCandidate[];
	readonly truncated: boolean;
}

export interface UnavailableInstalledGoModuleVersion {
	readonly status: "unavailable";
	readonly code: "manifest-not-found" | "module-not-found" | "version-not-found" | "corrupt-manifest" | "checksum-mismatch";
	readonly manifest?: string;
}

export interface OversizedInstalledGoModuleVersion {
	readonly status: "oversized";
	readonly resource: "manifest-bytes" | "manifest-entries" | "diagnostics" | "workspace-modules";
	readonly limit: number;
}

export type InstalledGoModuleVersionOutcome =
	| ResolvedInstalledGoModuleVersion
	| AmbiguousInstalledGoModuleVersion
	| UnavailableInstalledGoModuleVersion
	| OversizedInstalledGoModuleVersion;
