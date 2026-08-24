export interface InstalledCrateVersionRequest {
	readonly projectRoot: string;
	/** The dependent crate's own local name for this dependency -- may be a Cargo.toml `package = "..."` alias, not necessarily the real crate's registry name. */
	readonly crateName: string;
	readonly requestedVersion: string | null;
}

export interface InstalledCrateVersionBounds {
	readonly maxManifestBytes: number;
	readonly maxManifestEntries: number;
	readonly maxDiagnostics: number;
	readonly maxCandidates: number;
	readonly maxEvidencePerVersion: number;
}

/** How this crate's source is actually reachable. A workspace-local crate (Cargo.lock's own entry with no `source` field at all) has no registry/git provenance whatsoever. */
export type RustInstallKind = "registry" | "git" | "path";

export interface InstalledCrateEvidence {
	readonly manifest: string;
	/** The manifest's own locator text for this entry (a `[[package]]` header, or a Cargo.toml dependency line) -- opaque, for diagnostics only. */
	readonly locator: string;
	readonly kind: RustInstallKind;
	/** The crate's real registry name, when this evidence came from a Cargo.toml `package = "..."` rename -- null when the request's own crateName is already the real name. */
	readonly realName: string | null;
	/** Present only for kind "registry": the resolved index URL (crates.io's default, or an alternate registry's own configured index). */
	readonly registryUrl: string | null;
	/** Present only for kind "git": the repository URL, independent of any registry. */
	readonly directSource: string | null;
	/** An already-known exact commit -- from Cargo.lock's own `git+<url>#<sha>` fragment, or an explicit Cargo.toml `rev = "<full sha>"`. */
	readonly commit: string | null;
	/** A tag or branch name, known but not yet resolved to a commit -- used as a ref guess when no exact commit is available. */
	readonly gitRef: string | null;
	/** Cargo.lock's own declared checksum, when present -- absent (not mismatched) for a path/git dependency, or a registry crate whose own index entry has none (e.g. a yanked release on some mirrors). */
	readonly checksum: string | null;
}

export interface ResolvedInstalledCrateVersion {
	readonly status: "resolved";
	readonly crateName: string;
	readonly requestedVersion: string | null;
	readonly version: string;
	readonly evidence: readonly InstalledCrateEvidence[];
	readonly evidenceTruncated: boolean;
}

export interface InstalledCrateVersionCandidate {
	readonly version: string;
	readonly evidence: readonly InstalledCrateEvidence[];
	readonly evidenceTruncated: boolean;
}

export interface AmbiguousInstalledCrateVersion {
	readonly status: "ambiguous";
	readonly crateName: string;
	readonly requestedVersion: null;
	readonly candidates: readonly InstalledCrateVersionCandidate[];
	readonly truncated: boolean;
}

export interface UnavailableInstalledCrateVersion {
	readonly status: "unavailable";
	readonly code: "manifest-not-found" | "crate-not-found" | "version-not-found" | "corrupt-manifest" | "checksum-mismatch";
	readonly manifest?: string;
}

export interface OversizedInstalledCrateVersion {
	readonly status: "oversized";
	readonly resource: "manifest-bytes" | "manifest-entries" | "diagnostics";
	readonly limit: number;
}

export type InstalledCrateVersionOutcome =
	| ResolvedInstalledCrateVersion
	| AmbiguousInstalledCrateVersion
	| UnavailableInstalledCrateVersion
	| OversizedInstalledCrateVersion;
