import { assertAbsolutePath } from "../path-safety/assert-absolute-path.ts";
import {
	type AmbiguousPackageSource,
	type MismatchedPackageSource,
	type OversizedPackageSource,
	PACKAGE_ECOSYSTEMS,
	type PackageSourceBounds,
	type PackageSourceOutcome,
	type PackageSourceRequest,
	type UnauthenticatedPackageSource,
	type VerifiedPackageSource,
} from "./package-source.ts";
import type { PackageSourceResolverPort } from "./resolver-port.ts";

const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const VERIFICATION_METHODS = ["lockfile-vcs-pin", "registry-metadata-and-commit", "source-artifact-checksum", "local-content-digest"] as const;
const UNAVAILABLE_CODES = [
	"package-not-found",
	"version-not-found",
	"source-metadata-missing",
	"unsupported-ecosystem",
	"unsupported-manifest",
	"unverifiable-source",
] as const;
const AMBIGUOUS_CODES = ["multiple-installed-versions", "multiple-source-candidates"] as const;
const UNAUTHENTICATED_CODES = ["registry-authentication-required", "repository-authentication-required"] as const;
const OVERSIZED_CODES = ["manifest-limit-exceeded", "registry-response-limit-exceeded", "clone-limit-exceeded", "cache-limit-exceeded"] as const;
const OVERSIZED_RESOURCES = [
	"manifest-bytes",
	"manifest-entries",
	"manifest-nesting",
	"workspaces",
	"diagnostics",
	"registry-response-bytes",
	"clone-bytes",
	"cache-bytes",
] as const;
const MISMATCHED_CODES = ["coordinate-mismatch", "repository-ref-mismatch", "repository-commit-mismatch", "integrity-mismatch"] as const;

export class InvalidPackageSourceContract extends Error {
	constructor(reason: string) {
		super(`invalid package-source contract: ${reason}`);
		this.name = "InvalidPackageSourceContract";
	}
}

function containsControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function assertText(value: string, name: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength || containsControlCharacter(value)) throw new InvalidPackageSourceContract(name);
}

function assertOptionalText(value: string | null, name: string, maxLength: number): void {
	if (value !== null) assertText(value, name, maxLength);
}

function assertAllowed(value: string, allowed: readonly string[], name: string): void {
	if (!allowed.includes(value)) throw new InvalidPackageSourceContract(name);
}

function assertPositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new InvalidPackageSourceContract(name);
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new InvalidPackageSourceContract(name);
}

function validateRequest(request: PackageSourceRequest): void {
	assertText(request.projectRoot, "projectRoot", 4096);
	// Same trust boundary as workspace.registerPath: a daemon has no caller-relative cwd of its
	// own, so a relative projectRoot must be rejected here rather than trusted to already be
	// pre-resolved by every current and future caller.
	assertAbsolutePath(request.projectRoot);
	assertAllowed(request.coordinate.ecosystem, PACKAGE_ECOSYSTEMS, "coordinate.ecosystem");
	assertText(request.coordinate.name, "coordinate.name", 512);
	assertOptionalText(request.coordinate.registry, "coordinate.registry", 2048);
	assertOptionalText(request.coordinate.requestedVersion, "coordinate.requestedVersion", 256);
}

function validateBounds(bounds: PackageSourceBounds): void {
	assertPositiveSafeInteger(bounds.maxManifestBytes, "maxManifestBytes");
	assertPositiveSafeInteger(bounds.maxManifestEntries, "maxManifestEntries");
	assertPositiveSafeInteger(bounds.maxManifestNesting, "maxManifestNesting");
	assertPositiveSafeInteger(bounds.maxWorkspaces, "maxWorkspaces");
	assertPositiveSafeInteger(bounds.maxDiagnostics, "maxDiagnostics");
	assertPositiveSafeInteger(bounds.maxRegistryResponseBytes, "maxRegistryResponseBytes");
	assertNonNegativeSafeInteger(bounds.maxRedirects, "maxRedirects");
	assertNonNegativeSafeInteger(bounds.maxRetries, "maxRetries");
	assertPositiveSafeInteger(bounds.maxCloneBytes, "maxCloneBytes");
	assertPositiveSafeInteger(bounds.maxCacheBytes, "maxCacheBytes");
	assertPositiveSafeInteger(bounds.maxCandidates, "maxCandidates");
	assertPositiveSafeInteger(bounds.timeoutMs, "timeoutMs");
}

function validateVerified(outcome: VerifiedPackageSource, request: PackageSourceRequest): void {
	if (outcome.coordinate.ecosystem !== request.coordinate.ecosystem || outcome.coordinate.name !== request.coordinate.name) {
		throw new InvalidPackageSourceContract("resolved coordinate differs from request");
	}
	if (outcome.coordinate.requestedVersion !== request.coordinate.requestedVersion || outcome.coordinate.registry !== request.coordinate.registry) {
		throw new InvalidPackageSourceContract("resolved request identity differs from request");
	}
	assertText(outcome.coordinate.resolvedVersion, "coordinate.resolvedVersion", 256);
	assertOptionalText(outcome.coordinate.registry, "coordinate.registry", 2048);
	assertOptionalText(outcome.repository.url, "repository.url", 4096);
	assertOptionalText(outcome.repository.requestedRef, "repository.requestedRef", 512);
	assertOptionalText(outcome.repository.resolvedRef, "repository.resolvedRef", 512);
	if (outcome.repository.requestedRef !== null && outcome.repository.resolvedRef !== outcome.repository.requestedRef) {
		throw new InvalidPackageSourceContract("verified source cannot fall back from requestedRef");
	}
	assertAllowed(outcome.workspace.origin, ["local", "fetched"], "workspace.origin");
	if (outcome.workspace.origin === "fetched") {
		if (outcome.repository.commit === null || !COMMIT_HASH.test(outcome.repository.commit)) {
			throw new InvalidPackageSourceContract("fetched source requires an exact commit");
		}
		if (outcome.repository.url === null || outcome.repository.resolvedRef === null) {
			throw new InvalidPackageSourceContract("fetched source requires repository identity");
		}
	} else if (outcome.repository.commit !== null && !COMMIT_HASH.test(outcome.repository.commit)) {
		throw new InvalidPackageSourceContract("repository.commit");
	}
	// Type says always true/"verified"; a non-compliant adapter at this port boundary might not.
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	if (outcome.workspace.readOnly !== true) throw new InvalidPackageSourceContract("workspace must be read-only");
	assertText(outcome.workspace.cachePath, "workspace.cachePath", 4096);
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see comment above
	if (outcome.verification.status !== "verified") throw new InvalidPackageSourceContract("verification.status");
	assertAllowed(outcome.verification.method, VERIFICATION_METHODS, "verification.method");
	assertText(outcome.verification.integrity, "verification.integrity", 1024);
}

function validateAmbiguous(outcome: AmbiguousPackageSource, bounds: PackageSourceBounds): void {
	assertAllowed(outcome.code, AMBIGUOUS_CODES, "ambiguous.code");
	if (outcome.candidates.length === 0 || outcome.candidates.length > bounds.maxCandidates) {
		throw new InvalidPackageSourceContract("ambiguous candidates exceed bounds");
	}
	for (const candidate of outcome.candidates) {
		assertText(candidate.version, "candidate.version", 256);
		assertText(candidate.source, "candidate.source", 4096);
	}
}

function validateUnauthenticated(outcome: UnauthenticatedPackageSource, bounds: PackageSourceBounds): void {
	assertAllowed(outcome.code, UNAUTHENTICATED_CODES, "unauthenticated.code");
	if (outcome.requiredCredentialNames.length === 0 || outcome.requiredCredentialNames.length > bounds.maxCandidates) {
		throw new InvalidPackageSourceContract("requiredCredentialNames exceed bounds");
	}
	for (const name of outcome.requiredCredentialNames) {
		if (!CREDENTIAL_NAME.test(name)) throw new InvalidPackageSourceContract("credential names must be environment-variable names");
	}
}

function validateOversized(outcome: OversizedPackageSource): void {
	assertAllowed(outcome.code, OVERSIZED_CODES, "oversized.code");
	assertAllowed(outcome.resource, OVERSIZED_RESOURCES, "oversized.resource");
	assertPositiveSafeInteger(outcome.limit, "oversized.limit");
	if (outcome.observed !== null) {
		assertPositiveSafeInteger(outcome.observed, "oversized.observed");
		if (outcome.observed <= outcome.limit) throw new InvalidPackageSourceContract("oversized observation does not exceed limit");
	}
}

function validateMismatched(outcome: MismatchedPackageSource): void {
	assertAllowed(outcome.code, MISMATCHED_CODES, "mismatched.code");
	assertText(outcome.expected, "mismatch.expected", 4096);
	assertText(outcome.actual, "mismatch.actual", 4096);
	if (outcome.expected === outcome.actual) throw new InvalidPackageSourceContract("mismatch values are equal");
}

function validateOutcome(outcome: PackageSourceOutcome, request: PackageSourceRequest, bounds: PackageSourceBounds): void {
	switch (outcome.status) {
		case "verified":
			validateVerified(outcome, request);
			return;
		case "unavailable":
			assertAllowed(outcome.code, UNAVAILABLE_CODES, "unavailable.code");
			return;
		case "ambiguous":
			validateAmbiguous(outcome, bounds);
			return;
		case "unauthenticated":
			validateUnauthenticated(outcome, bounds);
			return;
		case "oversized":
			validateOversized(outcome);
			return;
		case "mismatched":
			validateMismatched(outcome);
			return;
		default: {
			const exhaustive: never = outcome;
			throw new InvalidPackageSourceContract(`outcome.status: ${JSON.stringify(exhaustive)}`);
		}
	}
}

export async function resolvePackageSource(
	resolver: PackageSourceResolverPort,
	request: PackageSourceRequest,
	bounds: PackageSourceBounds,
): Promise<PackageSourceOutcome> {
	validateRequest(request);
	validateBounds(bounds);
	const outcome = await resolver.resolve(request, bounds);
	validateOutcome(outcome, request, bounds);
	return outcome;
}
