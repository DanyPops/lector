import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHashOf } from "../content-identity/content-hash.ts";
import type { PackageSourceBounds, PackageSourceOutcome, PackageSourceRequest, VerifiedPackageSource } from "../package-source/package-source.ts";
import type { PackageSourceResolverPort } from "../package-source/resolver-port.ts";
import type { InstalledPythonEvidence, InstalledPythonVersionOutcome } from "../python-package-version-resolver/installed-package-version.ts";
import type { InstalledPythonVersionResolverPort } from "../python-package-version-resolver/port.ts";
import type { RepoFetcherPort } from "../repo-fetcher/port.ts";
import { RepoFetchFailed, RepoFetchLimitExceeded, type RepoFetchResult } from "../repo-fetcher/repo-fetch-result.ts";
import { type NormalizedPypiRepository, normalizePypiRepository, parseOwnerRepoUrl, pypiRepositoryReference } from "./normalize-pypi-repository.ts";
import type { PypiRegistryPort } from "./port.ts";
import type { PypiPackageVersionMetadata } from "./pypi-package-metadata.ts";
import {
	DEFAULT_PYPI_REGISTRY,
	PypiPackageNotFound,
	PypiRegistryAuthenticationRequired,
	PypiRegistryRequestFailed,
	PypiRegistryResponseLimitExceeded,
	PypiVersionNotFound,
} from "./pypi-registry-client.ts";

const COMMIT_HASH = /^[0-9a-f]{40,64}$/i;

export interface PypiPackageSourceResolverOptions {
	readonly versions: InstalledPythonVersionResolverPort;
	readonly registry: PypiRegistryPort;
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

function installedOutcome(outcome: InstalledPythonVersionOutcome, bounds: PackageSourceBounds): PackageSourceOutcome | InstalledPythonEvidence[] {
	switch (outcome.status) {
		case "resolved":
			return [...outcome.evidence];
		case "ambiguous":
			return {
				status: "ambiguous",
				code: "multiple-installed-versions",
				candidates: outcome.candidates.slice(0, bounds.maxCandidates).map((candidate) => ({
					version: candidate.version,
					source: bounded(candidate.evidence[0] ? `${candidate.evidence[0].lockfile}:${candidate.evidence[0].locator}` : "lockfile"),
				})),
				truncated: outcome.truncated || outcome.candidates.length > bounds.maxCandidates,
			};
		case "oversized":
			return { status: "oversized", code: "manifest-limit-exceeded", resource: outcome.resource, limit: outcome.limit, observed: null };
		case "unavailable":
			return {
				status: "unavailable",
				code:
					outcome.code === "package-not-found" || outcome.code === "lockfile-not-found"
						? "package-not-found"
						: outcome.code === "version-not-found"
							? "version-not-found"
							: "unsupported-manifest",
			};
	}
}

/** Reads a real `pyproject.toml` (PEP 621's own `[project]` name/version table) at `root` and reports its own declared identity, or a bounded outcome when the manifest is missing, oversized, or unreadable. */
function pyprojectIdentity(root: string, bounds: PackageSourceBounds): SourceIdentity | PackageSourceOutcome {
	let manifestPath: string;
	let size: number;
	try {
		manifestPath = realpathSync(resolve(root, "pyproject.toml"));
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
	if (!isRecord(parsed) || !isRecord(parsed.project)) return { status: "unavailable", code: "unverifiable-source" };
	return { name: textField(parsed.project, "name"), version: textField(parsed.project, "version") };
}

function candidateRefs(name: string, version: string, maxCandidates: number): readonly string[] {
	return Array.from(new Set([`v${version}`, version, `${name}-${version}`, `${name}_v${version}`]))
		.filter((ref) => ref.length <= 512)
		.slice(0, maxCandidates);
}

function verifiedOutcome(
	request: PackageSourceRequest,
	version: string,
	repository: NormalizedPypiRepository,
	ref: string,
	result: RepoFetchResult,
): VerifiedPackageSource {
	return {
		status: "verified",
		coordinate: { ...request.coordinate, resolvedVersion: version },
		repository: { url: repository.url, requestedRef: ref, resolvedRef: result.resolvedRef, commit: result.commit },
		workspace: { cachePath: result.path, origin: "fetched", readOnly: true },
		verification: { status: "verified", method: "registry-metadata-and-commit", integrity: `git:${result.commit}` },
	};
}

/** A directly-known local editable install (a `file://` path, from a real PEP 610 `direct_url.json` or a uv.lock/poetry.lock local-source entry) needs no fetch at all -- it's already a real, live directory. */
function localFilePath(directSource: string): string | null {
	if (directSource.startsWith("file://")) {
		try {
			return fileURLToPath(directSource);
		} catch {
			return null;
		}
	}
	return directSource.startsWith("/") || directSource.startsWith("./") || directSource.startsWith("../") ? directSource : null;
}

export class PypiPackageSourceResolver implements PackageSourceResolverPort {
	private readonly versions: InstalledPythonVersionResolverPort;
	private readonly registry: PypiRegistryPort;
	private readonly repositories: RepoFetcherPort;

	constructor(options: PypiPackageSourceResolverOptions) {
		this.versions = options.versions;
		this.registry = options.registry;
		this.repositories = options.repositories;
	}

	async resolve(request: PackageSourceRequest, bounds: PackageSourceBounds): Promise<PackageSourceOutcome> {
		if (request.coordinate.ecosystem !== "pypi") return { status: "unavailable", code: "unsupported-ecosystem" };
		const installed = await this.versions.resolve(
			{ projectRoot: request.projectRoot, packageName: request.coordinate.name, requestedVersion: request.coordinate.requestedVersion },
			{
				maxManifestBytes: bounds.maxManifestBytes,
				maxManifestEntries: bounds.maxManifestEntries,
				maxManifestNesting: bounds.maxManifestNesting,
				maxDiagnostics: bounds.maxDiagnostics,
				maxCandidates: bounds.maxCandidates,
				maxEvidencePerVersion: bounds.maxCandidates,
			},
		);
		const resolved = installedOutcome(installed, bounds);
		if (!Array.isArray(resolved)) return resolved;
		const version = installed.status === "resolved" ? installed.version : "";
		const primaryEvidence = resolved[0];

		if (primaryEvidence && primaryEvidence.kind !== "registry") return this.resolveFromEvidence(request, version, primaryEvidence, bounds);
		return this.resolveFromRegistry(request, version, bounds);
	}

	/** An editable/direct-VCS/direct-URL install already names its own real source directly -- no PyPI registry lookup is even meaningful here (it may not correspond to any published release at all). */
	private async resolveFromEvidence(
		request: PackageSourceRequest,
		version: string,
		evidence: InstalledPythonEvidence,
		bounds: PackageSourceBounds,
	): Promise<PackageSourceOutcome> {
		if (evidence.kind === "direct-url") return { status: "unavailable", code: "source-metadata-missing" };
		if (evidence.directSource === null) return { status: "unavailable", code: "source-metadata-missing" };

		const localPath = evidence.kind === "editable" ? localFilePath(evidence.directSource) : null;
		if (localPath !== null) return this.resolveLocalEditable(request, version, localPath, bounds);

		const repository = parseOwnerRepoUrl(evidence.directSource);
		if (repository === null) return { status: "unavailable", code: "unverifiable-source" };
		if (evidence.commit !== null && !COMMIT_HASH.test(evidence.commit) && evidence.commit.length === 0)
			return { status: "unavailable", code: "unverifiable-source" };

		const ref = evidence.commit ?? `v${version}`;
		let fetched: RepoFetchResult;
		try {
			fetched = await this.repositories.fetch(pypiRepositoryReference(repository, ref), {
				exactRef: evidence.commit !== null,
				maxCloneBytes: bounds.maxCloneBytes,
				maxCacheBytes: bounds.maxCacheBytes,
				timeoutMs: bounds.timeoutMs,
			});
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
			return { status: "unavailable", code: "unverifiable-source" };
		}
		if (fetched.refFallbackOccurred || fetched.resolvedRef !== ref) {
			return { status: "mismatched", code: "repository-ref-mismatch", expected: ref, actual: fetched.resolvedRef };
		}
		return {
			status: "verified",
			coordinate: { ...request.coordinate, resolvedVersion: version },
			repository: { url: repository.url, requestedRef: ref, resolvedRef: fetched.resolvedRef, commit: fetched.commit },
			workspace: { cachePath: fetched.path, origin: "fetched", readOnly: true },
			verification: { status: "verified", method: "lockfile-vcs-pin", integrity: `git:${fetched.commit}` },
		};
	}

	private resolveLocalEditable(request: PackageSourceRequest, version: string, localPath: string, bounds: PackageSourceBounds): Promise<PackageSourceOutcome> {
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(localPath);
		} catch {
			return Promise.resolve({ status: "unavailable", code: "unverifiable-source" });
		}
		if (!stats.isDirectory()) return Promise.resolve({ status: "unavailable", code: "unverifiable-source" });
		const identity = pyprojectIdentity(localPath, bounds);
		if ("status" in identity) return Promise.resolve(identity);
		if (identity.name !== request.coordinate.name) {
			return Promise.resolve({
				status: "mismatched",
				code: "coordinate-mismatch",
				expected: bounded(`${request.coordinate.name}@${version}`),
				actual: bounded(`${identity.name ?? "missing"}@${identity.version ?? "missing"}`),
			});
		}
		const manifestText = readFileSync(resolve(localPath, "pyproject.toml"), "utf8");
		return Promise.resolve({
			status: "verified",
			coordinate: { ...request.coordinate, resolvedVersion: version },
			repository: { url: null, requestedRef: null, resolvedRef: null, commit: null },
			workspace: { cachePath: localPath, origin: "local", readOnly: true },
			verification: { status: "verified", method: "local-content-digest", integrity: `sha256:${contentHashOf(manifestText)}` },
		});
	}

	private async resolveFromRegistry(request: PackageSourceRequest, version: string, bounds: PackageSourceBounds): Promise<PackageSourceOutcome> {
		let metadata: PypiPackageVersionMetadata;
		try {
			metadata = await this.registry.fetchVersion(
				{ registry: request.coordinate.registry ?? DEFAULT_PYPI_REGISTRY, name: request.coordinate.name, version },
				{ maxResponseBytes: bounds.maxRegistryResponseBytes, maxRedirects: bounds.maxRedirects, maxRetries: bounds.maxRetries, timeoutMs: bounds.timeoutMs },
			);
		} catch (error) {
			if (error instanceof PypiPackageNotFound) return { status: "unavailable", code: "package-not-found" };
			if (error instanceof PypiVersionNotFound) return { status: "unavailable", code: "version-not-found" };
			if (error instanceof PypiRegistryAuthenticationRequired) {
				return { status: "unauthenticated", code: "registry-authentication-required", requiredCredentialNames: error.requiredCredentialNames };
			}
			if (error instanceof PypiRegistryResponseLimitExceeded) {
				return {
					status: "oversized",
					code: "registry-response-limit-exceeded",
					resource: "registry-response-bytes",
					limit: error.limit,
					observed: error.observed,
				};
			}
			if (error instanceof PypiRegistryRequestFailed) return { status: "unavailable", code: "unverifiable-source" };
			return { status: "unavailable", code: "unverifiable-source" };
		}

		if (metadata.name !== request.coordinate.name || metadata.version !== version) {
			return {
				status: "mismatched",
				code: "coordinate-mismatch",
				expected: bounded(`${request.coordinate.name}@${version}`),
				actual: bounded(`${metadata.name}@${metadata.version}`),
			};
		}
		const repository = normalizePypiRepository(metadata.projectUrls);
		if (repository === null) return { status: "unavailable", code: "source-metadata-missing" };

		const refs = candidateRefs(request.coordinate.name, version, bounds.maxCandidates);
		const deadline = Date.now() + bounds.timeoutMs;
		let firstMismatch: PackageSourceOutcome | undefined;
		for (const ref of refs) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return { status: "unavailable", code: "unverifiable-source" };
			let fetched: RepoFetchResult;
			try {
				fetched = await this.repositories.fetch(pypiRepositoryReference(repository, ref), {
					exactRef: true,
					maxCloneBytes: bounds.maxCloneBytes,
					maxCacheBytes: bounds.maxCacheBytes,
					timeoutMs: remaining,
				});
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
				if (error instanceof RepoFetchFailed) continue;
				continue;
			}
			if (fetched.refFallbackOccurred || fetched.resolvedRef !== ref) {
				firstMismatch ??= { status: "mismatched", code: "repository-ref-mismatch", expected: ref, actual: fetched.resolvedRef };
				continue;
			}
			let identity: SourceIdentity | PackageSourceOutcome;
			try {
				identity = pyprojectIdentity(fetched.path, bounds);
			} catch {
				continue;
			}
			if ("status" in identity) {
				if (identity.status === "oversized") return identity;
				continue;
			}
			if (identity.name !== request.coordinate.name || identity.version !== version) {
				firstMismatch ??= {
					status: "mismatched",
					code: "coordinate-mismatch",
					expected: bounded(`${request.coordinate.name}@${version}`),
					actual: bounded(`${identity.name ?? "missing"}@${identity.version ?? "missing"}`),
				};
				continue;
			}
			return verifiedOutcome(request, version, repository, ref, fetched);
		}
		return firstMismatch ?? { status: "unavailable", code: "unverifiable-source" };
	}
}
