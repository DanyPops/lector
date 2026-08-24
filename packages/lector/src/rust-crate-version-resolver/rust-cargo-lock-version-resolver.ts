import type {
	InstalledCrateEvidence,
	InstalledCrateVersionBounds,
	InstalledCrateVersionCandidate,
	InstalledCrateVersionOutcome,
	InstalledCrateVersionRequest,
} from "./installed-crate.ts";
import {
	HARD_MAX_CANDIDATES,
	HARD_MAX_DIAGNOSTICS,
	HARD_MAX_EVIDENCE_PER_VERSION,
	HARD_MAX_MANIFEST_BYTES,
	HARD_MAX_MANIFEST_ENTRIES,
	ManifestResourceLimitExceeded,
	resourceLimitOutcome,
} from "./limits.ts";
import { type ParsedCargoLockPackage, parseCargoLock } from "./parsers/cargo-lock.ts";
import { parseCargoLockSource } from "./parsers/cargo-lock-source.ts";
import { type ParsedCargoTomlDependency, parseCargoToml } from "./parsers/cargo-toml.ts";
import type { InstalledCrateVersionResolverPort } from "./port.ts";
import { RustResolutionContext } from "./resolution-context.ts";

export class InvalidInstalledCrateVersionRequest extends Error {
	constructor(field: string) {
		super(`invalid installed crate-version request: ${field}`);
		this.name = "InvalidInstalledCrateVersionRequest";
	}
}

function assertText(value: string, field: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength) throw new InvalidInstalledCrateVersionRequest(field);
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) throw new InvalidInstalledCrateVersionRequest(field);
	}
}

function assertBound(value: number, field: string, hardMaximum: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) throw new InvalidInstalledCrateVersionRequest(field);
}

function validateInput(request: InstalledCrateVersionRequest, bounds: InstalledCrateVersionBounds): void {
	assertText(request.projectRoot, "projectRoot", 4096);
	assertText(request.crateName, "crateName", 512);
	if (request.requestedVersion !== null) assertText(request.requestedVersion, "requestedVersion", 256);
	assertBound(bounds.maxManifestBytes, "maxManifestBytes", HARD_MAX_MANIFEST_BYTES);
	assertBound(bounds.maxManifestEntries, "maxManifestEntries", HARD_MAX_MANIFEST_ENTRIES);
	assertBound(bounds.maxDiagnostics, "maxDiagnostics", HARD_MAX_DIAGNOSTICS);
	assertBound(bounds.maxCandidates, "maxCandidates", HARD_MAX_CANDIDATES);
	assertBound(bounds.maxEvidencePerVersion, "maxEvidencePerVersion", HARD_MAX_EVIDENCE_PER_VERSION);
}

interface ParsedEvidence {
	readonly version: string;
	readonly evidence: InstalledCrateEvidence;
}

function evidenceFromLockPackage(entry: ParsedCargoLockPackage, realName: string | null): ParsedEvidence {
	const source = parseCargoLockSource(entry.source);
	return {
		version: entry.version,
		evidence: {
			manifest: "Cargo.lock",
			locator: entry.locator,
			kind: source.kind,
			realName,
			registryUrl: source.registryUrl,
			directSource: source.directSource,
			commit: source.commit,
			gitRef: source.gitRef,
			checksum: entry.checksum,
		},
	};
}

/** Synthesizes evidence directly from Cargo.toml's own git spec -- used only when Cargo.lock has no matching entry at all for the (real) crate name, e.g. a lockfile fixture that doesn't cover every declared dependency. */
function evidenceFromTomlGit(realName: string, name: string, dependency: ParsedCargoTomlDependency): ParsedEvidence | null {
	if (dependency.git === null) return null;
	const version = dependency.git.rev ?? dependency.git.tag ?? dependency.git.branch ?? dependency.git.url;
	return {
		version,
		evidence: {
			manifest: "Cargo.toml",
			locator: `${name} = { git = "${dependency.git.url}" }`,
			kind: "git",
			realName: realName === name ? null : realName,
			registryUrl: null,
			directSource: dependency.git.url,
			commit: dependency.git.rev,
			gitRef: dependency.git.rev === null ? (dependency.git.tag ?? dependency.git.branch) : null,
			checksum: null,
		},
	};
}

function mergeCandidates(parsed: readonly ParsedEvidence[], maxEvidencePerVersion: number): InstalledCrateVersionCandidate[] {
	const byVersion = new Map<string, InstalledCrateEvidence[]>();
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
 * Resolves the exact installed version of a Rust crate from real Cargo.toml/Cargo.lock
 * manifests. Cargo.lock's own `[[package]]` entries are the authoritative source of exact
 * version/source/checksum identity; Cargo.toml is consulted for what Cargo.lock never records at
 * all -- a `package = "..."` rename (Cargo.lock always uses the crate's real registry name, never
 * a consuming crate's own local alias), an alternate registry's own index URL, and a git
 * dependency's exact rev/tag/branch when no Cargo.lock entry covers it.
 */
export class RustCargoLockVersionResolver implements InstalledCrateVersionResolverPort {
	resolve(request: InstalledCrateVersionRequest, bounds: InstalledCrateVersionBounds): Promise<InstalledCrateVersionOutcome> {
		validateInput(request, bounds);
		const context = new RustResolutionContext(request.projectRoot, bounds);

		const hasToml = context.hasProjectFile("Cargo.toml");
		const hasLock = context.hasProjectFile("Cargo.lock");
		if (!hasToml && !hasLock) return Promise.resolve({ status: "unavailable", code: "manifest-not-found" });

		let tomlDependency: ParsedCargoTomlDependency | undefined;
		let realName = request.crateName;
		let registryUrlByName: string | undefined;
		if (hasToml) {
			let toml: ReturnType<typeof parseCargoToml>;
			try {
				toml = parseCargoToml(context.readProjectFile("Cargo.toml"));
			} catch (error) {
				if (error instanceof ManifestResourceLimitExceeded) return Promise.resolve(resourceLimitOutcome(error, bounds));
				return Promise.resolve({ status: "unavailable", code: "corrupt-manifest", manifest: "Cargo.toml" });
			}
			tomlDependency = toml.dependencies.get(request.crateName);
			if (tomlDependency?.realName) realName = tomlDependency.realName;
			if (tomlDependency?.registryName) registryUrlByName = toml.registries.get(tomlDependency.registryName);
		}

		const parsed: ParsedEvidence[] = [];
		if (hasLock) {
			let packages: readonly ParsedCargoLockPackage[];
			try {
				packages = parseCargoLock(context.readProjectFile("Cargo.lock"));
			} catch (error) {
				if (error instanceof ManifestResourceLimitExceeded) return Promise.resolve(resourceLimitOutcome(error, bounds));
				return Promise.resolve({ status: "unavailable", code: "corrupt-manifest", manifest: "Cargo.lock" });
			}
			const checksumsByVersion = new Map<string, Set<string>>();
			for (const entry of packages) {
				if (entry.name !== realName) continue;
				context.touchEntry();
				if (entry.checksum !== null) {
					const seen = checksumsByVersion.get(entry.version) ?? new Set<string>();
					seen.add(entry.checksum);
					checksumsByVersion.set(entry.version, seen);
					if (seen.size > 1) return Promise.resolve({ status: "unavailable", code: "checksum-mismatch", manifest: "Cargo.lock" });
				}
				const evidence = evidenceFromLockPackage(entry, realName === request.crateName ? null : realName);
				parsed.push(
					registryUrlByName && evidence.evidence.kind === "registry"
						? { ...evidence, evidence: { ...evidence.evidence, registryUrl: registryUrlByName } }
						: evidence,
				);
			}
		}

		if (parsed.length === 0 && tomlDependency) {
			const synthesized = evidenceFromTomlGit(realName, request.crateName, tomlDependency);
			if (synthesized) parsed.push(synthesized);
		}

		if (parsed.length === 0) return Promise.resolve({ status: "unavailable", code: "crate-not-found" });

		let candidates = mergeCandidates(parsed, bounds.maxEvidencePerVersion);
		if (request.requestedVersion !== null) candidates = candidates.filter(({ version }) => version === request.requestedVersion);
		if (candidates.length === 0) {
			return Promise.resolve({ status: "unavailable", code: request.requestedVersion === null ? "crate-not-found" : "version-not-found" });
		}
		if (candidates.length === 1) {
			const candidate = candidates[0];
			if (!candidate) return Promise.resolve({ status: "unavailable", code: "crate-not-found" });
			return Promise.resolve({
				status: "resolved",
				crateName: request.crateName,
				requestedVersion: request.requestedVersion,
				version: candidate.version,
				evidence: candidate.evidence,
				evidenceTruncated: candidate.evidenceTruncated,
			});
		}
		return Promise.resolve({
			status: "ambiguous",
			crateName: request.crateName,
			requestedVersion: null,
			candidates: candidates.slice(0, bounds.maxCandidates),
			truncated: candidates.length > bounds.maxCandidates,
		});
	}
}
