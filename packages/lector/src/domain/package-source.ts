export type PackageEcosystem = "npm" | "pypi" | "cargo" | "go" | "maven" | "conan" | "vcpkg" | "nuget" | "swiftpm";

export interface PackageCoordinateRequest {
	readonly ecosystem: PackageEcosystem;
	readonly registry: string | null;
	readonly name: string;
	readonly requestedVersion: string | null;
}

export interface PackageSourceRequest {
	readonly projectRoot: string;
	readonly coordinate: PackageCoordinateRequest;
}

export interface PackageSourceBounds {
	readonly maxManifestBytes: number;
	readonly maxManifestEntries: number;
	readonly maxRegistryResponseBytes: number;
	readonly maxRedirects: number;
	readonly maxRetries: number;
	readonly maxCloneBytes: number;
	readonly maxCacheBytes: number;
	readonly maxCandidates: number;
	readonly timeoutMs: number;
}

export interface ResolvedPackageCoordinate extends PackageCoordinateRequest {
	readonly resolvedVersion: string;
}

export interface PackageRepositoryIdentity {
	readonly url: string | null;
	readonly requestedRef: string | null;
	readonly resolvedRef: string | null;
	readonly commit: string | null;
}

export interface PackageSourceWorkspace {
	readonly cachePath: string;
	readonly origin: "local" | "fetched";
	readonly readOnly: true;
}

export type PackageSourceVerificationMethod = "lockfile-vcs-pin" | "registry-metadata-and-commit" | "source-artifact-checksum" | "local-content-digest";

export interface PackageSourceVerification {
	readonly status: "verified";
	readonly method: PackageSourceVerificationMethod;
	readonly integrity: string;
}

export interface VerifiedPackageSource {
	readonly status: "verified";
	readonly coordinate: ResolvedPackageCoordinate;
	readonly repository: PackageRepositoryIdentity;
	readonly workspace: PackageSourceWorkspace;
	readonly verification: PackageSourceVerification;
}

export type PackageSourceUnavailableCode =
	| "package-not-found"
	| "version-not-found"
	| "source-metadata-missing"
	| "unsupported-ecosystem"
	| "unsupported-manifest"
	| "unverifiable-source";

export interface UnavailablePackageSource {
	readonly status: "unavailable";
	readonly code: PackageSourceUnavailableCode;
}

export interface PackageSourceCandidate {
	readonly version: string;
	readonly source: string;
}

export interface AmbiguousPackageSource {
	readonly status: "ambiguous";
	readonly code: "multiple-installed-versions" | "multiple-source-candidates";
	readonly candidates: readonly PackageSourceCandidate[];
	readonly truncated: boolean;
}

export interface UnauthenticatedPackageSource {
	readonly status: "unauthenticated";
	readonly code: "registry-authentication-required" | "repository-authentication-required";
	readonly requiredCredentialNames: readonly string[];
}

export interface OversizedPackageSource {
	readonly status: "oversized";
	readonly code: "manifest-limit-exceeded" | "registry-response-limit-exceeded" | "clone-limit-exceeded" | "cache-limit-exceeded";
	readonly resource: "manifest-bytes" | "manifest-entries" | "registry-response-bytes" | "clone-bytes" | "cache-bytes";
	readonly limit: number;
	readonly observed: number | null;
}

export interface MismatchedPackageSource {
	readonly status: "mismatched";
	readonly code: "coordinate-mismatch" | "repository-ref-mismatch" | "repository-commit-mismatch" | "integrity-mismatch";
	readonly expected: string;
	readonly actual: string;
}

export type PackageSourceOutcome =
	| VerifiedPackageSource
	| UnavailablePackageSource
	| AmbiguousPackageSource
	| UnauthenticatedPackageSource
	| OversizedPackageSource
	| MismatchedPackageSource;
