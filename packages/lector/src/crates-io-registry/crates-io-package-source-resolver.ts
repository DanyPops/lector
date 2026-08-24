import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { contentHashOf } from "../content-identity/content-hash.ts";
import { type NormalizedGitRepository, normalizeGitRepositoryUrl } from "../package-source/normalize-git-repository-url.ts";
import type { PackageSourceBounds, PackageSourceOutcome, PackageSourceRequest, VerifiedPackageSource } from "../package-source/package-source.ts";
import type { PackageSourceResolverPort } from "../package-source/resolver-port.ts";
import type { RepoFetcherPort } from "../repo-fetcher/port.ts";
import { RepoFetchFailed, RepoFetchLimitExceeded, type RepoFetchResult } from "../repo-fetcher/repo-fetch-result.ts";
import type { InstalledCrateEvidence, InstalledCrateVersionOutcome } from "../rust-crate-version-resolver/installed-crate.ts";
import type { InstalledCrateVersionResolverPort } from "../rust-crate-version-resolver/port.ts";
import type { CratesIoPackageVersionMetadata } from "./crates-io-package-metadata.ts";
import {
	CratesIoAuthenticationRequired,
	CratesIoCrateNotFound,
	CratesIoRegistryRequestFailed,
	CratesIoRegistryResponseLimitExceeded,
	CratesIoVersionNotFound,
	DEFAULT_CRATES_IO_REGISTRY,
} from "./crates-io-registry-client.ts";
import type { CratesIoRegistryPort } from "./port.ts";

const CRATES_IO_INDEX_MARKER = "https://github.com/rust-lang/crates.io-index";

export interface CratesIoPackageSourceResolverOptions {
	readonly versions: InstalledCrateVersionResolverPort;
	readonly registry: CratesIoRegistryPort;
	readonly repositories: RepoFetcherPort;
}

interface SourceIdentity {
	readonly name: string | null;
	readonly version: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function bounded(value: string, maxLength = 4096): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function installedOutcome(outcome: InstalledCrateVersionOutcome, bounds: PackageSourceBounds): PackageSourceOutcome | InstalledCrateEvidence[] {
	switch (outcome.status) {
		case "resolved":
			return [...outcome.evidence];
		case "ambiguous":
			return {
				status: "ambiguous",
				code: "multiple-installed-versions",
				candidates: outcome.candidates.slice(0, bounds.maxCandidates).map((candidate) => ({
					version: candidate.version,
					source: bounded(candidate.evidence[0] ? `${candidate.evidence[0].manifest}:${candidate.evidence[0].locator}` : "Cargo.lock"),
				})),
				truncated: outcome.truncated || outcome.candidates.length > bounds.maxCandidates,
			};
		case "oversized":
			return { status: "oversized", code: "manifest-limit-exceeded", resource: outcome.resource, limit: outcome.limit, observed: null };
		case "unavailable":
			return {
				status: "unavailable",
				code: outcome.code === "manifest-not-found" || outcome.code === "crate-not-found" ? "package-not-found" : "version-not-found",
			};
	}
}

/** Reads a real Cargo.toml at `root` and reports its own `[package]` name/version, or a bounded outcome when the manifest is missing, oversized, or unreadable. */
function cargoTomlIdentity(root: string, bounds: PackageSourceBounds): SourceIdentity | PackageSourceOutcome {
	let manifestPath: string;
	let size: number;
	try {
		manifestPath = realpathSync(resolve(root, "Cargo.toml"));
		const rootReal = realpathSync(root);
		if (!manifestPath.startsWith(`${rootReal}/`) && manifestPath !== rootReal) return { status: "unavailable", code: "unverifiable-source" };
		const stats = statSync(manifestPath);
		if (!stats.isFile()) return { status: "unavailable", code: "unverifiable-source" };
		size = stats.size;
	} catch {
		return { status: "unavailable", code: "unverifiable-source" };
	}
	if (size > bounds.maxManifestBytes) {
		return { status: "oversized", code: "manifest-limit-exceeded", resource: "manifest-bytes", limit: bounds.maxManifestBytes, observed: size };
	}
	const text = readFileSync(manifestPath, "utf8");
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(text);
	} catch {
		return { status: "unavailable", code: "unverifiable-source" };
	}
	if (!isRecord(parsed) || !isRecord(parsed.package)) return { status: "unavailable", code: "unverifiable-source" };
	return { name: textField(parsed.package, "name"), version: textField(parsed.package, "version") };
}

function candidateRefs(version: string, maxCandidates: number): readonly string[] {
	return Array.from(new Set([`v${version}`, version]))
		.filter((ref) => ref.length <= 512)
		.slice(0, maxCandidates);
}

function verifiedOutcome(
	request: PackageSourceRequest,
	version: string,
	repository: NormalizedGitRepository,
	ref: string,
	result: RepoFetchResult,
	method: VerifiedPackageSource["verification"]["method"],
): VerifiedPackageSource {
	return {
		status: "verified",
		coordinate: { ...request.coordinate, resolvedVersion: version },
		repository: { url: repository.url, requestedRef: ref, resolvedRef: result.resolvedRef, commit: result.commit },
		workspace: { cachePath: result.path, origin: "fetched", readOnly: true },
		verification: { status: "verified", method, integrity: `git:${result.commit}` },
	};
}

export class CratesIoPackageSourceResolver implements PackageSourceResolverPort {
	private readonly versions: InstalledCrateVersionResolverPort;
	private readonly registry: CratesIoRegistryPort;
	private readonly repositories: RepoFetcherPort;

	constructor(options: CratesIoPackageSourceResolverOptions) {
		this.versions = options.versions;
		this.registry = options.registry;
		this.repositories = options.repositories;
	}

	async resolve(request: PackageSourceRequest, bounds: PackageSourceBounds): Promise<PackageSourceOutcome> {
		if (request.coordinate.ecosystem !== "cargo") return { status: "unavailable", code: "unsupported-ecosystem" };
		const installed = await this.versions.resolve(
			{ projectRoot: request.projectRoot, crateName: request.coordinate.name, requestedVersion: request.coordinate.requestedVersion },
			{
				maxManifestBytes: bounds.maxManifestBytes,
				maxManifestEntries: bounds.maxManifestEntries,
				maxDiagnostics: bounds.maxDiagnostics,
				maxCandidates: bounds.maxCandidates,
				maxEvidencePerVersion: bounds.maxCandidates,
			},
		);
		const resolved = installedOutcome(installed, bounds);
		if (!Array.isArray(resolved)) return resolved;
		const version = installed.status === "resolved" ? installed.version : "";
		const primary = resolved[0];

		if (primary?.kind === "path" && primary.directSource !== null) return this.resolveLocalPath(request, version, primary.directSource, bounds);
		if (primary?.kind === "git") return this.resolveFromGit(request, version, primary, bounds);
		return this.resolveFromRegistry(request, version, primary ?? null, bounds);
	}

	private resolveLocalPath(request: PackageSourceRequest, version: string, localPath: string, bounds: PackageSourceBounds): Promise<PackageSourceOutcome> {
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(localPath);
		} catch {
			return Promise.resolve({ status: "unavailable", code: "unverifiable-source" });
		}
		if (!stats.isDirectory()) return Promise.resolve({ status: "unavailable", code: "unverifiable-source" });
		const identity = cargoTomlIdentity(localPath, bounds);
		if ("status" in identity) return Promise.resolve(identity);
		if (identity.name !== request.coordinate.name) {
			return Promise.resolve({
				status: "mismatched",
				code: "coordinate-mismatch",
				expected: bounded(`${request.coordinate.name}@${version}`),
				actual: bounded(`${identity.name ?? "missing"}@${identity.version ?? "missing"}`),
			});
		}
		const manifestText = readFileSync(resolve(localPath, "Cargo.toml"), "utf8");
		return Promise.resolve({
			status: "verified",
			coordinate: { ...request.coordinate, resolvedVersion: version },
			repository: { url: null, requestedRef: null, resolvedRef: null, commit: null },
			workspace: { cachePath: localPath, origin: "local", readOnly: true },
			verification: { status: "verified", method: "local-content-digest", integrity: `sha256:${contentHashOf(manifestText)}` },
		});
	}

	private async resolveFromGit(
		request: PackageSourceRequest,
		version: string,
		evidence: InstalledCrateEvidence,
		bounds: PackageSourceBounds,
	): Promise<PackageSourceOutcome> {
		if (evidence.directSource === null) return { status: "unavailable", code: "source-metadata-missing" };
		const repository = normalizeGitRepositoryUrl(evidence.directSource);
		if (repository === null) return { status: "unavailable", code: "unverifiable-source" };

		const ref = evidence.commit ?? evidence.gitRef;
		if (ref === null) return { status: "unavailable", code: "unverifiable-source" };
		const exactRef = evidence.commit !== null;

		let fetched: RepoFetchResult;
		try {
			fetched = await this.repositories.fetch(
				{ host: repository.host, owner: repository.owner, repo: repository.repo, ref },
				{ exactRef, maxCloneBytes: bounds.maxCloneBytes, maxCacheBytes: bounds.maxCacheBytes, timeoutMs: bounds.timeoutMs },
			);
		} catch (error) {
			if (error instanceof RepoFetchLimitExceeded) {
				return {
					status: "oversized",
					code: error.resource === "clone-bytes" ? "clone-limit-exceeded" : "cache-limit-exceeded",
					resource: error.resource,
					limit: error.limit,
					observed: error.observed,
				};
			}
			if (error instanceof RepoFetchFailed) return { status: "unavailable", code: "unverifiable-source" };
			return { status: "unavailable", code: "unverifiable-source" };
		}
		if (fetched.refFallbackOccurred || fetched.resolvedRef !== ref) {
			return { status: "mismatched", code: "repository-ref-mismatch", expected: ref, actual: fetched.resolvedRef };
		}
		return verifiedOutcome(request, version, repository, ref, fetched, exactRef ? "lockfile-vcs-pin" : "registry-metadata-and-commit");
	}

	private async resolveFromRegistry(
		request: PackageSourceRequest,
		version: string,
		evidence: InstalledCrateEvidence | null,
		bounds: PackageSourceBounds,
	): Promise<PackageSourceOutcome> {
		const declaredRegistryUrl = evidence?.registryUrl ?? null;
		const registryUrl = declaredRegistryUrl === null || declaredRegistryUrl === CRATES_IO_INDEX_MARKER ? DEFAULT_CRATES_IO_REGISTRY : declaredRegistryUrl;
		const realName = evidence?.realName ?? request.coordinate.name;

		let metadata: CratesIoPackageVersionMetadata;
		try {
			metadata = await this.registry.fetchVersion(
				{ registryUrl, registryName: request.coordinate.registry, name: realName, version },
				{ maxResponseBytes: bounds.maxRegistryResponseBytes, maxRedirects: bounds.maxRedirects, maxRetries: bounds.maxRetries, timeoutMs: bounds.timeoutMs },
			);
		} catch (error) {
			if (error instanceof CratesIoCrateNotFound) return { status: "unavailable", code: "package-not-found" };
			if (error instanceof CratesIoVersionNotFound) return { status: "unavailable", code: "version-not-found" };
			if (error instanceof CratesIoAuthenticationRequired) {
				return { status: "unauthenticated", code: "registry-authentication-required", requiredCredentialNames: error.requiredCredentialNames };
			}
			if (error instanceof CratesIoRegistryResponseLimitExceeded) {
				return {
					status: "oversized",
					code: "registry-response-limit-exceeded",
					resource: "registry-response-bytes",
					limit: error.limit,
					observed: error.observed,
				};
			}
			if (error instanceof CratesIoRegistryRequestFailed) return { status: "unavailable", code: "unverifiable-source" };
			return { status: "unavailable", code: "unverifiable-source" };
		}

		if (metadata.name !== realName || metadata.version !== version) {
			return {
				status: "mismatched",
				code: "coordinate-mismatch",
				expected: bounded(`${realName}@${version}`),
				actual: bounded(`${metadata.name}@${metadata.version}`),
			};
		}
		if (metadata.repository === null) return { status: "unavailable", code: "source-metadata-missing" };
		const repository = normalizeGitRepositoryUrl(metadata.repository);
		if (repository === null) return { status: "unavailable", code: "source-metadata-missing" };

		const refs = candidateRefs(version, bounds.maxCandidates);
		const deadline = Date.now() + bounds.timeoutMs;
		let firstMismatch: PackageSourceOutcome | undefined;
		for (const ref of refs) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return { status: "unavailable", code: "unverifiable-source" };
			let fetched: RepoFetchResult;
			try {
				fetched = await this.repositories.fetch(
					{ host: repository.host, owner: repository.owner, repo: repository.repo, ref },
					{ exactRef: true, maxCloneBytes: bounds.maxCloneBytes, maxCacheBytes: bounds.maxCacheBytes, timeoutMs: remaining },
				);
			} catch (error) {
				if (error instanceof RepoFetchLimitExceeded) {
					return {
						status: "oversized",
						code: error.resource === "clone-bytes" ? "clone-limit-exceeded" : "cache-limit-exceeded",
						resource: error.resource,
						limit: error.limit,
						observed: error.observed,
					};
				}
				continue;
			}
			if (fetched.refFallbackOccurred || fetched.resolvedRef !== ref) {
				firstMismatch ??= { status: "mismatched", code: "repository-ref-mismatch", expected: ref, actual: fetched.resolvedRef };
				continue;
			}
			let identity: SourceIdentity | PackageSourceOutcome;
			try {
				identity = cargoTomlIdentity(fetched.path, bounds);
			} catch {
				continue;
			}
			if ("status" in identity) {
				if (identity.status === "oversized") return identity;
				continue;
			}
			if (identity.name !== realName || identity.version !== version) {
				firstMismatch ??= {
					status: "mismatched",
					code: "coordinate-mismatch",
					expected: bounded(`${realName}@${version}`),
					actual: bounded(`${identity.name ?? "missing"}@${identity.version ?? "missing"}`),
				};
				continue;
			}
			return verifiedOutcome(request, version, repository, ref, fetched, "registry-metadata-and-commit");
		}
		return firstMismatch ?? { status: "unavailable", code: "unverifiable-source" };
	}
}
