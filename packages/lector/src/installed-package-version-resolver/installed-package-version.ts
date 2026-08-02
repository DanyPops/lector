export type JavaScriptPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface InstalledPackageVersionRequest {
	readonly projectRoot: string;
	readonly packageName: string;
	readonly requestedVersion: string | null;
}

export interface InstalledPackageVersionBounds {
	readonly maxManifestBytes: number;
	readonly maxManifestEntries: number;
	readonly maxManifestNesting: number;
	readonly maxWorkspaces: number;
	readonly maxDiagnostics: number;
	readonly maxCandidates: number;
	readonly maxEvidencePerVersion: number;
}

export interface InstalledPackageEvidence {
	readonly manager: JavaScriptPackageManager;
	readonly lockfile: string;
	readonly locator: string;
	readonly integrity: string | null;
	readonly workspace: boolean;
}

export interface ResolvedInstalledPackageVersion {
	readonly status: "resolved";
	readonly packageName: string;
	readonly requestedVersion: string | null;
	readonly version: string;
	readonly evidence: readonly InstalledPackageEvidence[];
	readonly evidenceTruncated: boolean;
}

export interface InstalledPackageVersionCandidate {
	readonly version: string;
	readonly evidence: readonly InstalledPackageEvidence[];
	readonly evidenceTruncated: boolean;
}

export interface AmbiguousInstalledPackageVersion {
	readonly status: "ambiguous";
	readonly packageName: string;
	readonly requestedVersion: null;
	readonly candidates: readonly InstalledPackageVersionCandidate[];
	readonly truncated: boolean;
}

export interface UnavailableInstalledPackageVersion {
	readonly status: "unavailable";
	readonly code: "lockfile-not-found" | "package-not-found" | "version-not-found" | "unsupported-lockfile" | "corrupt-lockfile";
	readonly lockfile?: string;
}

export interface OversizedInstalledPackageVersion {
	readonly status: "oversized";
	readonly resource: "manifest-bytes" | "manifest-entries" | "manifest-nesting" | "workspaces" | "diagnostics";
	readonly limit: number;
}

export type InstalledPackageVersionOutcome =
	| ResolvedInstalledPackageVersion
	| AmbiguousInstalledPackageVersion
	| UnavailableInstalledPackageVersion
	| OversizedInstalledPackageVersion;
