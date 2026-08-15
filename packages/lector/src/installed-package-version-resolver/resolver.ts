import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
	InstalledPackageEvidence,
	InstalledPackageVersionBounds,
	InstalledPackageVersionCandidate,
	InstalledPackageVersionOutcome,
	InstalledPackageVersionRequest,
} from "./installed-package-version.ts";
import {
	HARD_MAX_CANDIDATES,
	HARD_MAX_DIAGNOSTICS,
	HARD_MAX_EVIDENCE_PER_VERSION,
	HARD_MAX_MANIFEST_BYTES,
	HARD_MAX_MANIFEST_ENTRIES,
	HARD_MAX_MANIFEST_NESTING,
	HARD_MAX_WORKSPACES,
	ManifestResourceLimitExceeded,
	resourceLimitOutcome,
} from "./limits.ts";
import { parseBunLock } from "./parsers/bun-lock.ts";
import { parseNpmLock } from "./parsers/npm-lock.ts";
import { parsePnpmLock } from "./parsers/pnpm-lock.ts";
import type { ParsedEvidence } from "./parsers/shared.ts";
import { UnsupportedLockfile } from "./parsers/shared.ts";
import { parseYarnLock } from "./parsers/yarn-lock.ts";
import type { InstalledPackageVersionResolverPort } from "./port.ts";
import { type ManifestSyntax, ResolutionContext } from "./resolution-context.ts";

export class InvalidInstalledPackageVersionRequest extends Error {
	constructor(field: string) {
		super(`invalid installed-package version request: ${field}`);
		this.name = "InvalidInstalledPackageVersionRequest";
	}
}

function assertText(value: string, field: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength) throw new InvalidInstalledPackageVersionRequest(field);
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) throw new InvalidInstalledPackageVersionRequest(field);
	}
}

function assertBound(value: number, field: string, hardMaximum: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) throw new InvalidInstalledPackageVersionRequest(field);
}

function validateInput(request: InstalledPackageVersionRequest, bounds: InstalledPackageVersionBounds): void {
	assertText(request.projectRoot, "projectRoot", 4096);
	assertText(request.packageName, "packageName", 512);
	if (request.requestedVersion !== null) assertText(request.requestedVersion, "requestedVersion", 256);
	assertBound(bounds.maxManifestBytes, "maxManifestBytes", HARD_MAX_MANIFEST_BYTES);
	assertBound(bounds.maxManifestEntries, "maxManifestEntries", HARD_MAX_MANIFEST_ENTRIES);
	assertBound(bounds.maxManifestNesting, "maxManifestNesting", HARD_MAX_MANIFEST_NESTING);
	assertBound(bounds.maxWorkspaces, "maxWorkspaces", HARD_MAX_WORKSPACES);
	assertBound(bounds.maxDiagnostics, "maxDiagnostics", HARD_MAX_DIAGNOSTICS);
	assertBound(bounds.maxCandidates, "maxCandidates", HARD_MAX_CANDIDATES);
	assertBound(bounds.maxEvidencePerVersion, "maxEvidencePerVersion", HARD_MAX_EVIDENCE_PER_VERSION);
}

function mergeCandidates(parsed: readonly ParsedEvidence[], maxEvidencePerVersion: number): InstalledPackageVersionCandidate[] {
	const byVersion = new Map<string, InstalledPackageEvidence[]>();
	const truncatedVersions = new Set<string>();
	for (const entry of parsed) {
		const evidenceList = byVersion.get(entry.version) ?? [];
		if (
			!evidenceList.some(
				(item) => item.manager === entry.evidence.manager && item.lockfile === entry.evidence.lockfile && item.locator === entry.evidence.locator,
			)
		) {
			if (evidenceList.length < maxEvidencePerVersion) evidenceList.push(entry.evidence);
			else truncatedVersions.add(entry.version);
		}
		byVersion.set(entry.version, evidenceList);
	}
	return Array.from(byVersion, ([version, evidenceList]) => ({
		version,
		evidence: evidenceList,
		evidenceTruncated: truncatedVersions.has(version),
	})).sort((left, right) => left.version.localeCompare(right.version));
}

export class NpmLockfileVersionResolver implements InstalledPackageVersionResolverPort {
	resolve(request: InstalledPackageVersionRequest, bounds: InstalledPackageVersionBounds): Promise<InstalledPackageVersionOutcome> {
		validateInput(request, bounds);
		const npmLock = existsSync(join(request.projectRoot, "npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : "package-lock.json";
		const lockfiles = [npmLock, "pnpm-lock.yaml", "yarn.lock", "bun.lock"].filter((name) => existsSync(join(request.projectRoot, name)));
		if (lockfiles.length === 0) {
			const binaryBunLock = "bun.lockb";
			return Promise.resolve(
				existsSync(join(request.projectRoot, binaryBunLock))
					? { status: "unavailable", code: "unsupported-lockfile", lockfile: binaryBunLock }
					: { status: "unavailable", code: "lockfile-not-found" },
			);
		}

		const context = new ResolutionContext(request.projectRoot, bounds);
		const parsed: ParsedEvidence[] = [];
		for (const lockfile of lockfiles) {
			try {
				const syntax: ManifestSyntax = lockfile === "package-lock.json" || lockfile === "npm-shrinkwrap.json" || lockfile === "bun.lock" ? "json" : "yaml";
				const text = context.readProjectFile(lockfile, syntax);
				if (lockfile === "package-lock.json" || lockfile === "npm-shrinkwrap.json") parsed.push(...parseNpmLock(text, lockfile, request.packageName, context));
				else if (lockfile === "pnpm-lock.yaml") parsed.push(...parsePnpmLock(text, lockfile, request.packageName, context));
				else if (lockfile === "yarn.lock") parsed.push(...parseYarnLock(text, lockfile, request.packageName, context));
				else parsed.push(...parseBunLock(text, lockfile, request.packageName, context));
			} catch (error) {
				if (error instanceof ManifestResourceLimitExceeded) return Promise.resolve(resourceLimitOutcome(error, bounds));
				return Promise.resolve({
					status: "unavailable",
					code: error instanceof UnsupportedLockfile ? "unsupported-lockfile" : "corrupt-lockfile",
					lockfile,
				});
			}
		}

		let candidates = mergeCandidates(parsed, bounds.maxEvidencePerVersion);
		if (request.requestedVersion !== null) candidates = candidates.filter(({ version }) => version === request.requestedVersion);
		if (candidates.length === 0) {
			return Promise.resolve({ status: "unavailable", code: request.requestedVersion === null ? "package-not-found" : "version-not-found" });
		}
		if (candidates.length === 1) {
			const candidate = candidates[0];
			if (!candidate) return Promise.resolve({ status: "unavailable", code: "package-not-found" });
			return Promise.resolve({
				status: "resolved",
				packageName: request.packageName,
				requestedVersion: request.requestedVersion,
				version: candidate.version,
				evidence: candidate.evidence,
				evidenceTruncated: candidate.evidenceTruncated,
			});
		}
		const truncated = candidates.length > bounds.maxCandidates;
		return Promise.resolve({
			status: "ambiguous",
			packageName: request.packageName,
			requestedVersion: null,
			candidates: candidates.slice(0, bounds.maxCandidates),
			truncated,
		});
	}
}
