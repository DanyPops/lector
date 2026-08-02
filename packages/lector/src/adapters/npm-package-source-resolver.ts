import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { NpmPackageVersionMetadata } from "../domain/npm-package-metadata.ts";
import type { PackageSourceBounds, PackageSourceOutcome, PackageSourceRequest, VerifiedPackageSource } from "../domain/package-source.ts";
import type { InstalledPackageVersionCandidate, InstalledPackageVersionOutcome } from "../installed-package-version-resolver/installed-package-version.ts";
import type { InstalledPackageVersionResolverPort } from "../installed-package-version-resolver/port.ts";
import type { NpmRegistryPort } from "../ports/npm-registry-port.ts";
import type { PackageSourceResolverPort } from "../ports/package-source-resolver-port.ts";
import type { RepoFetcherPort } from "../repo-fetcher/port.ts";
import { RepoFetchFailed, RepoFetchLimitExceeded, type RepoFetchResult } from "../repo-fetcher/repo-fetch-result.ts";
import { type NormalizedNpmRepository, normalizeNpmRepository, npmRepositoryReference } from "./normalize-npm-repository.ts";
import {
	DEFAULT_NPM_REGISTRY,
	NpmPackageNotFound,
	NpmRegistryAuthenticationRequired,
	NpmRegistryRequestFailed,
	NpmRegistryResponseLimitExceeded,
	NpmVersionNotFound,
} from "./npm-registry-client.ts";

const COMMIT_HASH = /^[0-9a-f]{40,64}$/i;

export interface NpmPackageSourceResolverOptions {
	readonly versions: InstalledPackageVersionResolverPort;
	readonly registry: NpmRegistryPort;
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

function candidateSource(candidate: InstalledPackageVersionCandidate): string {
	const first = candidate.evidence[0];
	return first ? bounded(`${first.lockfile}:${first.locator}`) : "lockfile";
}

function installedOutcome(outcome: InstalledPackageVersionOutcome, bounds: PackageSourceBounds): PackageSourceOutcome | string {
	switch (outcome.status) {
		case "resolved":
			return outcome.version;
		case "ambiguous":
			return {
				status: "ambiguous",
				code: "multiple-installed-versions",
				candidates: outcome.candidates.slice(0, bounds.maxCandidates).map((candidate) => ({ version: candidate.version, source: candidateSource(candidate) })),
				truncated: outcome.truncated || outcome.candidates.length > bounds.maxCandidates,
			};
		case "oversized":
			return {
				status: "oversized",
				code: "manifest-limit-exceeded",
				resource: outcome.resource,
				limit: outcome.limit,
				observed: null,
			};
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

function sourceNesting(text: string): number {
	let depth = 0;
	let maximum = 0;
	let quoted = false;
	let escaped = false;
	for (const character of text) {
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') quoted = true;
		else if (character === "{" || character === "[") {
			depth++;
			maximum = Math.max(maximum, depth);
		} else if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
	}
	return maximum;
}

function sourceIdentity(repositoryRoot: string, directory: string | null, bounds: PackageSourceBounds): SourceIdentity | PackageSourceOutcome {
	const root = realpathSync(repositoryRoot);
	const packageRoot = realpathSync(directory === null ? root : resolve(root, directory));
	const relativePath = relative(root, packageRoot);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) return { status: "unavailable", code: "unverifiable-source" };
	let manifestPath: string;
	let size: number;
	try {
		manifestPath = realpathSync(join(packageRoot, "package.json"));
		const manifestRelativePath = relative(root, manifestPath);
		if (manifestRelativePath === ".." || manifestRelativePath.startsWith(`..${sep}`)) return { status: "unavailable", code: "unverifiable-source" };
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
	const nesting = sourceNesting(text);
	if (nesting > bounds.maxManifestNesting) {
		return { status: "oversized", code: "manifest-limit-exceeded", resource: "manifest-nesting", limit: bounds.maxManifestNesting, observed: nesting };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { status: "unavailable", code: "unverifiable-source" };
	}
	if (!isRecord(parsed)) return { status: "unavailable", code: "unverifiable-source" };
	return { name: textField(parsed, "name"), version: textField(parsed, "version") };
}

function packageRoot(repositoryRoot: string, directory: string | null): string {
	return directory === null ? repositoryRoot : resolve(repositoryRoot, directory);
}

function candidateRefs(name: string, version: string, maxCandidates: number): readonly string[] {
	const unscoped = name.includes("/") ? (name.split("/").at(-1) ?? name) : name;
	return Array.from(new Set([`v${version}`, `${unscoped}@${version}`, `${name}@${version}`, version]))
		.filter((ref) => ref.length <= 512)
		.slice(0, maxCandidates);
}

function verifiedOutcome(
	request: PackageSourceRequest,
	version: string,
	repository: NormalizedNpmRepository,
	ref: string,
	result: RepoFetchResult,
): VerifiedPackageSource {
	return {
		status: "verified",
		coordinate: { ...request.coordinate, resolvedVersion: version },
		repository: {
			url: repository.url,
			requestedRef: ref,
			resolvedRef: result.resolvedRef,
			commit: result.commit,
		},
		workspace: {
			cachePath: packageRoot(result.path, repository.directory),
			origin: "fetched",
			readOnly: true,
		},
		verification: {
			status: "verified",
			method: "registry-metadata-and-commit",
			integrity: `git:${result.commit}`,
		},
	};
}

export class NpmPackageSourceResolver implements PackageSourceResolverPort {
	private readonly versions: InstalledPackageVersionResolverPort;
	private readonly registry: NpmRegistryPort;
	private readonly repositories: RepoFetcherPort;

	constructor(options: NpmPackageSourceResolverOptions) {
		this.versions = options.versions;
		this.registry = options.registry;
		this.repositories = options.repositories;
	}

	async resolve(request: PackageSourceRequest, bounds: PackageSourceBounds): Promise<PackageSourceOutcome> {
		if (request.coordinate.ecosystem !== "npm") return { status: "unavailable", code: "unsupported-ecosystem" };
		const installed = await this.versions.resolve(
			{
				projectRoot: request.projectRoot,
				packageName: request.coordinate.name,
				requestedVersion: request.coordinate.requestedVersion,
			},
			{
				maxManifestBytes: bounds.maxManifestBytes,
				maxManifestEntries: bounds.maxManifestEntries,
				maxManifestNesting: bounds.maxManifestNesting,
				maxWorkspaces: bounds.maxWorkspaces,
				maxDiagnostics: bounds.maxDiagnostics,
				maxCandidates: bounds.maxCandidates,
				maxEvidencePerVersion: bounds.maxCandidates,
			},
		);
		const resolved = installedOutcome(installed, bounds);
		if (typeof resolved !== "string") return resolved;
		const version = resolved;

		let metadata: NpmPackageVersionMetadata;
		try {
			metadata = await this.registry.fetchVersion(
				{ registry: request.coordinate.registry ?? DEFAULT_NPM_REGISTRY, name: request.coordinate.name, version },
				{
					maxResponseBytes: bounds.maxRegistryResponseBytes,
					maxRedirects: bounds.maxRedirects,
					maxRetries: bounds.maxRetries,
					timeoutMs: bounds.timeoutMs,
				},
			);
		} catch (error) {
			if (error instanceof NpmPackageNotFound) return { status: "unavailable", code: "package-not-found" };
			if (error instanceof NpmVersionNotFound) return { status: "unavailable", code: "version-not-found" };
			if (error instanceof NpmRegistryAuthenticationRequired) {
				return { status: "unauthenticated", code: "registry-authentication-required", requiredCredentialNames: error.requiredCredentialNames };
			}
			if (error instanceof NpmRegistryResponseLimitExceeded) {
				return {
					status: "oversized",
					code: "registry-response-limit-exceeded",
					resource: "registry-response-bytes",
					limit: error.limit,
					observed: error.observed,
				};
			}
			if (error instanceof NpmRegistryRequestFailed) return { status: "unavailable", code: "unverifiable-source" };
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
		if (metadata.repository === null) return { status: "unavailable", code: "source-metadata-missing" };
		const repository = normalizeNpmRepository(metadata.repository);
		if (repository === null) return { status: "unavailable", code: "source-metadata-missing" };
		if (metadata.gitHead !== null && !COMMIT_HASH.test(metadata.gitHead)) return { status: "unavailable", code: "unverifiable-source" };
		const refs = metadata.gitHead === null ? candidateRefs(request.coordinate.name, version, bounds.maxCandidates) : [metadata.gitHead];
		const deadline = Date.now() + bounds.timeoutMs;
		let firstMismatch: PackageSourceOutcome | undefined;
		for (const ref of refs) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return { status: "unavailable", code: "unverifiable-source" };
			let fetched: RepoFetchResult;
			try {
				fetched = await this.repositories.fetch(npmRepositoryReference(repository, ref), {
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
				firstMismatch ??= {
					status: "mismatched",
					code: "repository-ref-mismatch",
					expected: ref,
					actual: fetched.resolvedRef,
				};
				continue;
			}
			if (metadata.gitHead !== null && fetched.commit.toLowerCase() !== metadata.gitHead.toLowerCase()) {
				return {
					status: "mismatched",
					code: "repository-commit-mismatch",
					expected: metadata.gitHead,
					actual: fetched.commit,
				};
			}
			let identity: SourceIdentity | PackageSourceOutcome;
			try {
				identity = sourceIdentity(fetched.path, repository.directory, bounds);
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
