import { findDirectUrlEvidence } from "./direct-url-fallback.ts";
import type {
	InstalledPythonEvidence,
	InstalledPythonVersionBounds,
	InstalledPythonVersionCandidate,
	InstalledPythonVersionOutcome,
	InstalledPythonVersionRequest,
} from "./installed-package-version.ts";
import {
	HARD_MAX_CANDIDATES,
	HARD_MAX_DIAGNOSTICS,
	HARD_MAX_EVIDENCE_PER_VERSION,
	HARD_MAX_MANIFEST_BYTES,
	HARD_MAX_MANIFEST_ENTRIES,
	HARD_MAX_MANIFEST_NESTING,
	ManifestResourceLimitExceeded,
	resourceLimitOutcome,
} from "./limits.ts";
import { parsePipfileLock } from "./parsers/pipfile-lock.ts";
import { parsePoetryLock } from "./parsers/poetry-lock.ts";
import { parseRequirementsTxt } from "./parsers/requirements-txt.ts";
import type { ParsedPythonEvidence } from "./parsers/shared.ts";
import { parseUvLock } from "./parsers/uv-lock.ts";
import type { InstalledPythonVersionResolverPort } from "./port.ts";
import { PythonResolutionContext } from "./resolution-context.ts";

export class InvalidInstalledPythonVersionRequest extends Error {
	constructor(field: string) {
		super(`invalid installed Python-version request: ${field}`);
		this.name = "InvalidInstalledPythonVersionRequest";
	}
}

function assertText(value: string, field: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength) throw new InvalidInstalledPythonVersionRequest(field);
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) throw new InvalidInstalledPythonVersionRequest(field);
	}
}

function assertBound(value: number, field: string, hardMaximum: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) throw new InvalidInstalledPythonVersionRequest(field);
}

function validateInput(request: InstalledPythonVersionRequest, bounds: InstalledPythonVersionBounds): void {
	assertText(request.projectRoot, "projectRoot", 4096);
	assertText(request.packageName, "packageName", 512);
	if (request.requestedVersion !== null) assertText(request.requestedVersion, "requestedVersion", 256);
	assertBound(bounds.maxManifestBytes, "maxManifestBytes", HARD_MAX_MANIFEST_BYTES);
	assertBound(bounds.maxManifestEntries, "maxManifestEntries", HARD_MAX_MANIFEST_ENTRIES);
	assertBound(bounds.maxManifestNesting, "maxManifestNesting", HARD_MAX_MANIFEST_NESTING);
	assertBound(bounds.maxDiagnostics, "maxDiagnostics", HARD_MAX_DIAGNOSTICS);
	assertBound(bounds.maxCandidates, "maxCandidates", HARD_MAX_CANDIDATES);
	assertBound(bounds.maxEvidencePerVersion, "maxEvidencePerVersion", HARD_MAX_EVIDENCE_PER_VERSION);
}

function mergeCandidates(parsed: readonly ParsedPythonEvidence[], maxEvidencePerVersion: number): InstalledPythonVersionCandidate[] {
	const byVersion = new Map<string, InstalledPythonEvidence[]>();
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
	return Array.from(byVersion, ([version, evidenceList]) => ({ version, evidence: evidenceList, evidenceTruncated: truncatedVersions.has(version) })).sort(
		(left, right) => left.version.localeCompare(right.version),
	);
}

const LOCKFILE_PARSERS = [
	{ lockfile: "uv.lock", parse: parseUvLock },
	{ lockfile: "poetry.lock", parse: parsePoetryLock },
	{ lockfile: "Pipfile.lock", parse: parsePipfileLock },
	{ lockfile: "requirements.txt", parse: parseRequirementsTxt },
] as const;

/**
 * Resolves the exact installed version of a Python package by trying every lockfile format
 * present at the project root (uv.lock, poetry.lock, Pipfile.lock, requirements.txt -- a project
 * can genuinely have more than one; every one present is consulted, not just the first found),
 * falling back to a real venv's own `direct_url.json` (PEP 610) only when no lockfile records the
 * package at all -- the one case no lockfile format is ever expected to cover (an editable/
 * direct-URL/direct-VCS install pip performed outside of any lockfile-managed workflow).
 */
export class PythonLockfileVersionResolver implements InstalledPythonVersionResolverPort {
	resolve(request: InstalledPythonVersionRequest, bounds: InstalledPythonVersionBounds): Promise<InstalledPythonVersionOutcome> {
		validateInput(request, bounds);
		const context = new PythonResolutionContext(request.projectRoot, bounds);
		const presentLockfiles = LOCKFILE_PARSERS.filter(({ lockfile }) => context.hasProjectFile(lockfile));

		const parsed: ParsedPythonEvidence[] = [];
		for (const { lockfile, parse } of presentLockfiles) {
			try {
				const text = context.readProjectFile(lockfile);
				parsed.push(...parse(text, lockfile, request.packageName, context));
			} catch (error) {
				if (error instanceof ManifestResourceLimitExceeded) return Promise.resolve(resourceLimitOutcome(error, bounds));
				return Promise.resolve({ status: "unavailable", code: "corrupt-lockfile", lockfile });
			}
		}

		if (parsed.length === 0) {
			let fallback: ParsedPythonEvidence | null;
			try {
				fallback = findDirectUrlEvidence(request.projectRoot, request.packageName, context);
			} catch (error) {
				if (error instanceof ManifestResourceLimitExceeded) return Promise.resolve(resourceLimitOutcome(error, bounds));
				throw error;
			}
			if (fallback) parsed.push(fallback);
		}

		if (parsed.length === 0 && presentLockfiles.length === 0) return Promise.resolve({ status: "unavailable", code: "lockfile-not-found" });

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
		return Promise.resolve({
			status: "ambiguous",
			packageName: request.packageName,
			requestedVersion: null,
			candidates: candidates.slice(0, bounds.maxCandidates),
			truncated: candidates.length > bounds.maxCandidates,
		});
	}
}
