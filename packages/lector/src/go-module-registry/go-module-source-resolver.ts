import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { contentHashOf } from "../content-identity/content-hash.ts";
import type { InstalledGoModuleEvidence, InstalledGoModuleVersionOutcome } from "../go-module-version-resolver/installed-go-module.ts";
import { parseGoMod } from "../go-module-version-resolver/parsers/go-mod.ts";
import type { InstalledGoModuleVersionResolverPort } from "../go-module-version-resolver/port.ts";
import type { PackageSourceBounds, PackageSourceOutcome, PackageSourceRequest, VerifiedPackageSource } from "../package-source/package-source.ts";
import type { PackageSourceResolverPort } from "../package-source/resolver-port.ts";
import type { RepoFetcherPort } from "../repo-fetcher/port.ts";
import { RepoFetchFailed, RepoFetchLimitExceeded, type RepoFetchResult } from "../repo-fetcher/repo-fetch-result.ts";
import { DEFAULT_GOPROXY, type GoProxyClient, GoProxyRequestFailed, GoProxyResponseLimitExceeded, GoProxyVersionNotFound } from "./go-proxy-client.ts";
import { type ParsedGoModulePath, parseGoModulePath } from "./parse-go-module-path.ts";

export interface GoModuleSourceResolverOptions {
	readonly versions: InstalledGoModuleVersionResolverPort;
	readonly proxy: GoProxyClient;
	readonly proxyUrl?: string;
	readonly repositories: RepoFetcherPort;
}

function bounded(value: string, maxLength = 4096): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function installedOutcome(outcome: InstalledGoModuleVersionOutcome, bounds: PackageSourceBounds): PackageSourceOutcome | InstalledGoModuleEvidence[] {
	switch (outcome.status) {
		case "resolved":
			return [...outcome.evidence];
		case "ambiguous":
			return {
				status: "ambiguous",
				code: "multiple-installed-versions",
				candidates: outcome.candidates.slice(0, bounds.maxCandidates).map((candidate) => ({
					version: candidate.version,
					source: bounded(candidate.evidence[0] ? `${candidate.evidence[0].manifest}:${candidate.evidence[0].locator}` : "go.mod"),
				})),
				truncated: outcome.truncated || outcome.candidates.length > bounds.maxCandidates,
			};
		case "oversized":
			return {
				status: "oversized",
				code: "manifest-limit-exceeded",
				resource: outcome.resource === "workspace-modules" ? "workspaces" : outcome.resource,
				limit: outcome.limit,
				observed: null,
			};
		case "unavailable":
			return {
				status: "unavailable",
				code: outcome.code === "manifest-not-found" || outcome.code === "module-not-found" ? "package-not-found" : "version-not-found",
			};
	}
}

interface GoModIdentity {
	readonly modulePath: string | null;
}

/** Reads a real go.mod at `directory` and reports its own declared module path, or null when the file is missing/unreadable -- distinct from an empty string, which never occurs for a real module declaration. */
function goModIdentity(directory: string, bounds: PackageSourceBounds): GoModIdentity | PackageSourceOutcome {
	let manifestPath: string;
	let size: number;
	try {
		manifestPath = realpathSync(join(directory, "go.mod"));
		const stats = statSync(manifestPath);
		if (!stats.isFile()) return { modulePath: null };
		size = stats.size;
	} catch {
		return { modulePath: null };
	}
	if (size > bounds.maxManifestBytes) {
		return { status: "oversized", code: "manifest-limit-exceeded", resource: "manifest-bytes", limit: bounds.maxManifestBytes, observed: size };
	}
	const parsed = parseGoMod(readFileSync(manifestPath, "utf8"));
	return { modulePath: parsed.modulePath };
}

/** Go's own tagging convention for a module living in a repo subdirectory: a nested go.mod tags its releases with a `<subdirectory>/vX.Y.Z` prefix; a plain (non-module) subpackage shares its parent module's own unprefixed tags. Both are real, common shapes -- tried in that order. */
function candidateRefs(parsed: ParsedGoModulePath, version: string): readonly string[] {
	return parsed.subdirectory ? [`${parsed.subdirectory}/${version}`, version] : [version];
}

function verifiedOutcome(
	request: PackageSourceRequest,
	version: string,
	parsed: ParsedGoModulePath,
	ref: string,
	result: RepoFetchResult,
	method: VerifiedPackageSource["verification"]["method"],
): VerifiedPackageSource {
	return {
		status: "verified",
		coordinate: { ...request.coordinate, resolvedVersion: version },
		repository: { url: `https://${parsed.host}/${parsed.owner}/${parsed.repo}.git`, requestedRef: ref, resolvedRef: result.resolvedRef, commit: result.commit },
		workspace: { cachePath: parsed.subdirectory ? join(result.path, parsed.subdirectory) : result.path, origin: "fetched", readOnly: true },
		verification: { status: "verified", method, integrity: `git:${result.commit}` },
	};
}

export class GoModuleSourceResolver implements PackageSourceResolverPort {
	private readonly versions: InstalledGoModuleVersionResolverPort;
	private readonly proxy: GoProxyClient;
	private readonly proxyUrl: string;
	private readonly repositories: RepoFetcherPort;

	constructor(options: GoModuleSourceResolverOptions) {
		this.versions = options.versions;
		this.proxy = options.proxy;
		this.proxyUrl = options.proxyUrl ?? DEFAULT_GOPROXY;
		this.repositories = options.repositories;
	}

	async resolve(request: PackageSourceRequest, bounds: PackageSourceBounds): Promise<PackageSourceOutcome> {
		if (request.coordinate.ecosystem !== "go") return { status: "unavailable", code: "unsupported-ecosystem" };
		const installed = await this.versions.resolve(
			{ projectRoot: request.projectRoot, modulePath: request.coordinate.name, requestedVersion: request.coordinate.requestedVersion },
			{
				maxManifestBytes: bounds.maxManifestBytes,
				maxManifestEntries: bounds.maxManifestEntries,
				maxDiagnostics: bounds.maxDiagnostics,
				maxCandidates: bounds.maxCandidates,
				maxEvidencePerVersion: bounds.maxCandidates,
				maxWorkspaceModules: bounds.maxWorkspaces,
			},
		);
		const resolved = installedOutcome(installed, bounds);
		if (!Array.isArray(resolved)) return resolved;
		const version = installed.status === "resolved" ? installed.version : "";
		const primary = resolved[0];

		if (primary?.kind === "local-replace" && primary.directSource !== null) return this.resolveLocalReplace(request, version, primary.directSource, bounds);

		const targetModulePath = primary?.kind === "vcs-replace" && primary.directSource !== null ? primary.directSource : request.coordinate.name;
		return this.resolveFromModulePath(request, version, targetModulePath, primary?.commit ?? null, primary?.kind === "vcs-replace", bounds);
	}

	private resolveLocalReplace(request: PackageSourceRequest, version: string, localPath: string, bounds: PackageSourceBounds): Promise<PackageSourceOutcome> {
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(localPath);
		} catch {
			return Promise.resolve({ status: "unavailable", code: "unverifiable-source" });
		}
		if (!stats.isDirectory()) return Promise.resolve({ status: "unavailable", code: "unverifiable-source" });
		const identity = goModIdentity(localPath, bounds);
		if ("status" in identity) return Promise.resolve(identity);
		if (identity.modulePath === null) return Promise.resolve({ status: "unavailable", code: "unverifiable-source" });
		const manifestText = readFileSync(resolve(localPath, "go.mod"), "utf8");
		return Promise.resolve({
			status: "verified",
			coordinate: { ...request.coordinate, resolvedVersion: version },
			repository: { url: null, requestedRef: null, resolvedRef: null, commit: null },
			workspace: { cachePath: localPath, origin: "local", readOnly: true },
			verification: { status: "verified", method: "local-content-digest", integrity: `sha256:${contentHashOf(manifestText)}` },
		});
	}

	private async resolveFromModulePath(
		request: PackageSourceRequest,
		version: string,
		modulePath: string,
		knownCommit: string | null,
		isReplace: boolean,
		bounds: PackageSourceBounds,
	): Promise<PackageSourceOutcome> {
		const parsed = parseGoModulePath(modulePath);
		if (parsed === null) return { status: "unavailable", code: "unverifiable-source" };

		if (knownCommit !== null) {
			return this.fetchAndVerify(
				request,
				version,
				parsed,
				modulePath,
				knownCommit,
				true,
				isReplace ? "lockfile-vcs-pin" : "registry-metadata-and-commit",
				bounds,
			);
		}

		try {
			await this.proxy.fetchVersionInfo(
				{ proxyUrl: this.proxyUrl, modulePath, version },
				{ maxResponseBytes: bounds.maxRegistryResponseBytes, maxRetries: bounds.maxRetries, timeoutMs: bounds.timeoutMs },
			);
		} catch (error) {
			if (error instanceof GoProxyVersionNotFound) return { status: "unavailable", code: "version-not-found" };
			if (error instanceof GoProxyResponseLimitExceeded) {
				return {
					status: "oversized",
					code: "registry-response-limit-exceeded",
					resource: "registry-response-bytes",
					limit: error.limit,
					observed: error.observed,
				};
			}
			if (!(error instanceof GoProxyRequestFailed)) throw error;
			// A GOPROXY network/timeout failure is not authoritative -- proceed to real clone-based identity verification, which is the actual source of truth either way.
		}

		const deadline = Date.now() + bounds.timeoutMs;
		let firstMismatch: PackageSourceOutcome | undefined;
		for (const ref of candidateRefs(parsed, version)) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return { status: "unavailable", code: "unverifiable-source" };
			const outcome = await this.fetchAndVerify(request, version, parsed, modulePath, ref, false, "registry-metadata-and-commit", bounds, remaining);
			if (outcome.status === "verified") return outcome;
			if (outcome.status === "oversized") return outcome;
			firstMismatch ??= outcome;
		}
		return firstMismatch ?? { status: "unavailable", code: "unverifiable-source" };
	}

	private async fetchAndVerify(
		request: PackageSourceRequest,
		version: string,
		parsed: ParsedGoModulePath,
		modulePath: string,
		ref: string,
		exactRef: boolean,
		method: VerifiedPackageSource["verification"]["method"],
		bounds: PackageSourceBounds,
		timeoutMs = bounds.timeoutMs,
	): Promise<PackageSourceOutcome> {
		let fetched: RepoFetchResult;
		try {
			fetched = await this.repositories.fetch(
				{ host: parsed.host, owner: parsed.owner, repo: parsed.repo, ref },
				{ exactRef: true, maxCloneBytes: bounds.maxCloneBytes, maxCacheBytes: bounds.maxCacheBytes, timeoutMs },
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
		if (exactRef && (fetched.refFallbackOccurred || fetched.resolvedRef !== ref)) {
			return { status: "mismatched", code: "repository-ref-mismatch", expected: ref, actual: fetched.resolvedRef };
		}
		if (!exactRef && (fetched.refFallbackOccurred || fetched.resolvedRef !== ref)) {
			return { status: "mismatched", code: "repository-ref-mismatch", expected: ref, actual: fetched.resolvedRef };
		}

		const nestedIdentity = parsed.subdirectory ? goModIdentity(join(fetched.path, parsed.subdirectory), bounds) : { modulePath: null };
		if ("status" in nestedIdentity) return nestedIdentity;
		if (nestedIdentity.modulePath === modulePath) return verifiedOutcome(request, version, parsed, ref, fetched, method);

		const rootIdentity = goModIdentity(fetched.path, bounds);
		if ("status" in rootIdentity) return rootIdentity;
		const expectedRootModulePath = parsed.subdirectory ? modulePath.slice(0, modulePath.length - parsed.subdirectory.length - 1) : modulePath;
		if (rootIdentity.modulePath === expectedRootModulePath) return verifiedOutcome(request, version, parsed, ref, fetched, method);

		return {
			status: "mismatched",
			code: "coordinate-mismatch",
			expected: bounded(modulePath),
			actual: bounded(nestedIdentity.modulePath ?? rootIdentity.modulePath ?? "missing"),
		};
	}
}
