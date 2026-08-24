export type PythonPackageManager = "pip" | "poetry" | "uv" | "pipenv";

export interface InstalledPythonVersionRequest {
	readonly projectRoot: string;
	readonly packageName: string;
	readonly requestedVersion: string | null;
}

export interface InstalledPythonVersionBounds {
	readonly maxManifestBytes: number;
	readonly maxManifestEntries: number;
	readonly maxManifestNesting: number;
	readonly maxDiagnostics: number;
	readonly maxCandidates: number;
	readonly maxEvidencePerVersion: number;
}

/**
 * How this version was actually installed -- a real distinction, not just provenance: an
 * editable/direct-VCS install has no meaningful "registry version" to look up on PyPI at all
 * (its source *is* the pinned ref already), unlike a normal registry-resolved install.
 */
export type PythonInstallKind = "registry" | "editable" | "direct-vcs" | "direct-url";

export interface InstalledPythonEvidence {
	readonly manager: PythonPackageManager;
	readonly lockfile: string;
	/** The lockfile's own locator text for this entry (e.g. a TOML `[[package]]` name, or a requirements.txt line) -- opaque, for diagnostics only. */
	readonly locator: string;
	readonly kind: PythonInstallKind;
	/** Present only for kind "direct-vcs"/"direct-url": the exact source location (a VCS URL or a local path), independent of any registry. */
	readonly directSource: string | null;
	/** Present only when a VCS-pinned commit is known directly from the lockfile/metadata (uv.lock, requirements.txt `-e git+...@<ref>`, or direct_url.json's vcs_info.commit_id) -- lets the source resolver skip an ambiguous ref guess entirely. */
	readonly commit: string | null;
}

export interface ResolvedInstalledPythonVersion {
	readonly status: "resolved";
	readonly packageName: string;
	readonly requestedVersion: string | null;
	readonly version: string;
	readonly evidence: readonly InstalledPythonEvidence[];
	readonly evidenceTruncated: boolean;
}

export interface InstalledPythonVersionCandidate {
	readonly version: string;
	readonly evidence: readonly InstalledPythonEvidence[];
	readonly evidenceTruncated: boolean;
}

export interface AmbiguousInstalledPythonVersion {
	readonly status: "ambiguous";
	readonly packageName: string;
	readonly requestedVersion: null;
	readonly candidates: readonly InstalledPythonVersionCandidate[];
	readonly truncated: boolean;
}

export interface UnavailableInstalledPythonVersion {
	readonly status: "unavailable";
	readonly code: "lockfile-not-found" | "package-not-found" | "version-not-found" | "unsupported-lockfile" | "corrupt-lockfile";
	readonly lockfile?: string;
}

export interface OversizedInstalledPythonVersion {
	readonly status: "oversized";
	readonly resource: "manifest-bytes" | "manifest-entries" | "manifest-nesting" | "diagnostics";
	readonly limit: number;
}

export type InstalledPythonVersionOutcome =
	| ResolvedInstalledPythonVersion
	| AmbiguousInstalledPythonVersion
	| UnavailableInstalledPythonVersion
	| OversizedInstalledPythonVersion;
