import type {
	InstalledGoModuleEvidence,
	InstalledGoModuleVersionBounds,
	InstalledGoModuleVersionCandidate,
	InstalledGoModuleVersionOutcome,
	InstalledGoModuleVersionRequest,
} from "./installed-go-module.ts";
import {
	HARD_MAX_CANDIDATES,
	HARD_MAX_DIAGNOSTICS,
	HARD_MAX_EVIDENCE_PER_VERSION,
	HARD_MAX_MANIFEST_BYTES,
	HARD_MAX_MANIFEST_ENTRIES,
	HARD_MAX_WORKSPACE_MODULES,
	ManifestResourceLimitExceeded,
	resourceLimitOutcome,
} from "./limits.ts";
import { type ParsedGoModReplace, parseGoMod } from "./parsers/go-mod.ts";
import { parseGoSum } from "./parsers/go-sum.ts";
import { parseGoWork } from "./parsers/go-work.ts";
import { isLocalReplacePath, looksLikeCommitHash, pseudoVersionCommit } from "./parsers/shared.ts";
import { parseVendorModulesTxt } from "./parsers/vendor-modules.ts";
import type { InstalledGoModuleVersionResolverPort } from "./port.ts";
import { GoResolutionContext } from "./resolution-context.ts";

export class InvalidInstalledGoModuleVersionRequest extends Error {
	constructor(field: string) {
		super(`invalid installed Go module-version request: ${field}`);
		this.name = "InvalidInstalledGoModuleVersionRequest";
	}
}

function assertText(value: string, field: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength) throw new InvalidInstalledGoModuleVersionRequest(field);
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) throw new InvalidInstalledGoModuleVersionRequest(field);
	}
}

function assertBound(value: number, field: string, hardMaximum: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) throw new InvalidInstalledGoModuleVersionRequest(field);
}

function validateInput(request: InstalledGoModuleVersionRequest, bounds: InstalledGoModuleVersionBounds): void {
	assertText(request.projectRoot, "projectRoot", 4096);
	assertText(request.modulePath, "modulePath", 512);
	if (request.requestedVersion !== null) assertText(request.requestedVersion, "requestedVersion", 256);
	assertBound(bounds.maxManifestBytes, "maxManifestBytes", HARD_MAX_MANIFEST_BYTES);
	assertBound(bounds.maxManifestEntries, "maxManifestEntries", HARD_MAX_MANIFEST_ENTRIES);
	assertBound(bounds.maxDiagnostics, "maxDiagnostics", HARD_MAX_DIAGNOSTICS);
	assertBound(bounds.maxCandidates, "maxCandidates", HARD_MAX_CANDIDATES);
	assertBound(bounds.maxEvidencePerVersion, "maxEvidencePerVersion", HARD_MAX_EVIDENCE_PER_VERSION);
	assertBound(bounds.maxWorkspaceModules, "maxWorkspaceModules", HARD_MAX_WORKSPACE_MODULES);
}

interface ParsedGoModEvidence {
	readonly version: string;
	readonly evidence: InstalledGoModuleEvidence;
}

function evidenceFromReplace(
	replace: ParsedGoModReplace,
	requireVersion: string | null,
	manifest: string,
	checksums: ReadonlyMap<string, { checksum: string; mismatched: boolean }>,
): ParsedGoModEvidence {
	if (isLocalReplacePath(replace.newPath)) {
		const version = requireVersion ?? replace.newPath;
		return {
			version,
			evidence: { manifest, locator: replace.locator, kind: "local-replace", directSource: replace.newPath, commit: null, checksum: null },
		};
	}
	const commit = replace.newVersion !== null && looksLikeCommitHash(replace.newVersion) ? replace.newVersion : null;
	const version = commit ?? requireVersion ?? replace.newVersion ?? replace.newPath;
	const checksumKey = replace.newVersion !== null ? `${replace.newPath}@${replace.newVersion}` : null;
	const checksumEntry = checksumKey ? checksums.get(checksumKey) : undefined;
	return {
		version,
		evidence: {
			manifest,
			locator: replace.locator,
			kind: "vcs-replace",
			directSource: replace.newPath,
			commit,
			checksum: checksumEntry?.mismatched ? null : (checksumEntry?.checksum ?? null),
		},
	};
}

function evidenceFromRequire(
	modulePath: string,
	version: string,
	locator: string,
	manifest: string,
	checksums: ReadonlyMap<string, { checksum: string; mismatched: boolean }>,
): ParsedGoModEvidence {
	const checksumEntry = checksums.get(`${modulePath}@${version}`);
	return {
		version,
		evidence: {
			manifest,
			locator,
			kind: "module-path",
			directSource: null,
			commit: pseudoVersionCommit(version),
			checksum: checksumEntry?.mismatched ? null : (checksumEntry?.checksum ?? null),
		},
	};
}

/** True only when a checksum was actually declared for modulePath@version and it was internally inconsistent -- a missing checksum (a private module with no sumdb entry) is never treated as a mismatch. */
function hasRealChecksumMismatch(modulePath: string, version: string, checksums: ReadonlyMap<string, { checksum: string; mismatched: boolean }>): boolean {
	return checksums.get(`${modulePath}@${version}`)?.mismatched === true;
}

function mergeCandidates(parsed: readonly ParsedGoModEvidence[], maxEvidencePerVersion: number): InstalledGoModuleVersionCandidate[] {
	const byVersion = new Map<string, InstalledGoModuleEvidence[]>();
	const truncatedVersions = new Set<string>();
	for (const entry of parsed) {
		const evidenceList = byVersion.get(entry.version) ?? [];
		if (!evidenceList.some((item) => item.manifest === entry.evidence.manifest && item.locator === entry.evidence.locator)) {
			if (evidenceList.length < maxEvidencePerVersion) evidenceList.push(entry.evidence);
			else truncatedVersions.add(entry.version);
		}
		byVersion.set(entry.version, evidenceList);
	}
	return Array.from(byVersion, ([version, evidenceList]) => ({ version, evidence: evidenceList, evidenceTruncated: truncatedVersions.has(version) })).sort(
		(left, right) => left.version.localeCompare(right.version),
	);
}

/**
 * Resolves the exact installed version of a Go module from real go.mod/go.work/go.sum/
 * vendor/modules.txt manifests. A go.work workspace's every `use` member has its own separate
 * go.mod worth consulting (a real Go workspace's own modules can each require a different
 * version of the same external dependency -- genuine ambiguity, not a bug to paper over), and
 * vendor/modules.txt is consulted as an independent manifest alongside go.mod, exactly like a
 * second lockfile format, not a fallback of last resort.
 */
export class GoModuleLockfileVersionResolver implements InstalledGoModuleVersionResolverPort {
	resolve(request: InstalledGoModuleVersionRequest, bounds: InstalledGoModuleVersionBounds): Promise<InstalledGoModuleVersionOutcome> {
		validateInput(request, bounds);
		const context = new GoResolutionContext(request.projectRoot, bounds);

		if (!context.hasProjectFile("go.mod")) return Promise.resolve({ status: "unavailable", code: "manifest-not-found" });

		let checksums: ReadonlyMap<string, { checksum: string; mismatched: boolean }> = new Map();
		if (context.hasProjectFile("go.sum")) {
			try {
				checksums = parseGoSum(context.readProjectFile("go.sum"));
			} catch (error) {
				if (error instanceof ManifestResourceLimitExceeded) return Promise.resolve(resourceLimitOutcome(error, bounds));
				return Promise.resolve({ status: "unavailable", code: "corrupt-manifest", manifest: "go.sum" });
			}
		}
		const manifestsToConsult = ["go.mod"];
		if (context.hasProjectFile("go.work")) {
			let work: ReturnType<typeof parseGoWork>;
			try {
				work = parseGoWork(context.readProjectFile("go.work"));
			} catch (error) {
				if (error instanceof ManifestResourceLimitExceeded) return Promise.resolve(resourceLimitOutcome(error, bounds));
				return Promise.resolve({ status: "unavailable", code: "corrupt-manifest", manifest: "go.work" });
			}
			for (const directory of work.useDirectories) {
				context.touchWorkspaceModule();
				if (directory === ".") continue;
				const memberManifest = `${directory.replace(/^\.\//, "")}/go.mod`;
				if (context.hasProjectFile(memberManifest)) manifestsToConsult.push(memberManifest);
			}
		}

		const parsed: ParsedGoModEvidence[] = [];
		for (const manifest of manifestsToConsult) {
			let text: string;
			try {
				text = context.readProjectFile(manifest);
			} catch (error) {
				if (error instanceof ManifestResourceLimitExceeded) return Promise.resolve(resourceLimitOutcome(error, bounds));
				return Promise.resolve({ status: "unavailable", code: "corrupt-manifest", manifest });
			}
			const goMod = parseGoMod(text);
			for (const require of goMod.requires) {
				context.touchEntry();
				if (require.modulePath !== request.modulePath) continue;
				if (hasRealChecksumMismatch(require.modulePath, require.version, checksums)) {
					return Promise.resolve({ status: "unavailable", code: "checksum-mismatch", manifest: "go.sum" });
				}
				const replace = goMod.replaces.find((candidate) => candidate.oldPath === require.modulePath);
				if (replace) {
					if (replace.newVersion !== null && hasRealChecksumMismatch(replace.newPath, replace.newVersion, checksums)) {
						return Promise.resolve({ status: "unavailable", code: "checksum-mismatch", manifest: "go.sum" });
					}
					parsed.push(evidenceFromReplace(replace, require.version, manifest, checksums));
				} else {
					parsed.push(evidenceFromRequire(require.modulePath, require.version, require.locator, manifest, checksums));
				}
			}
			for (const replace of goMod.replaces) {
				if (replace.oldPath !== request.modulePath) continue;
				if (goMod.requires.some((require) => require.modulePath === replace.oldPath)) continue; // already handled above, paired with its own require
				context.touchEntry();
				if (replace.newVersion !== null && hasRealChecksumMismatch(replace.newPath, replace.newVersion, checksums)) {
					return Promise.resolve({ status: "unavailable", code: "checksum-mismatch", manifest: "go.sum" });
				}
				parsed.push(evidenceFromReplace(replace, null, manifest, checksums));
			}
		}

		if (context.hasProjectFile("vendor/modules.txt")) {
			let text: string;
			try {
				text = context.readProjectFile("vendor/modules.txt");
			} catch (error) {
				if (error instanceof ManifestResourceLimitExceeded) return Promise.resolve(resourceLimitOutcome(error, bounds));
				return Promise.resolve({ status: "unavailable", code: "corrupt-manifest", manifest: "vendor/modules.txt" });
			}
			for (const entry of parseVendorModulesTxt(text)) {
				context.touchEntry();
				if (entry.modulePath !== request.modulePath) continue;
				if (hasRealChecksumMismatch(entry.modulePath, entry.version, checksums)) {
					return Promise.resolve({ status: "unavailable", code: "checksum-mismatch", manifest: "go.sum" });
				}
				parsed.push(evidenceFromRequire(entry.modulePath, entry.version, entry.locator, "vendor/modules.txt", checksums));
			}
		}

		if (parsed.length === 0) return Promise.resolve({ status: "unavailable", code: "module-not-found" });

		let candidates = mergeCandidates(parsed, bounds.maxEvidencePerVersion);
		if (request.requestedVersion !== null) candidates = candidates.filter(({ version }) => version === request.requestedVersion);
		if (candidates.length === 0) {
			return Promise.resolve({ status: "unavailable", code: request.requestedVersion === null ? "module-not-found" : "version-not-found" });
		}
		if (candidates.length === 1) {
			const candidate = candidates[0];
			if (!candidate) return Promise.resolve({ status: "unavailable", code: "module-not-found" });
			return Promise.resolve({
				status: "resolved",
				modulePath: request.modulePath,
				requestedVersion: request.requestedVersion,
				version: candidate.version,
				evidence: candidate.evidence,
				evidenceTruncated: candidate.evidenceTruncated,
			});
		}
		return Promise.resolve({
			status: "ambiguous",
			modulePath: request.modulePath,
			requestedVersion: null,
			candidates: candidates.slice(0, bounds.maxCandidates),
			truncated: candidates.length > bounds.maxCandidates,
		});
	}
}
