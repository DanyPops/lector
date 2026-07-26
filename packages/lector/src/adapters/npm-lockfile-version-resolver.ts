import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseSyml } from "@yarnpkg/parsers";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { parseDocument } from "yaml";
import type {
	InstalledPackageEvidence,
	InstalledPackageVersionBounds,
	InstalledPackageVersionCandidate,
	InstalledPackageVersionOutcome,
	InstalledPackageVersionRequest,
	JavaScriptPackageManager,
	OversizedInstalledPackageVersion,
} from "../domain/installed-package-version.ts";
import type { InstalledPackageVersionResolverPort } from "../ports/installed-package-version-resolver-port.ts";

interface ParsedEvidence {
	readonly version: string;
	readonly evidence: InstalledPackageEvidence;
}

type ManifestSyntax = "json" | "yaml";
type LimitedResource = OversizedInstalledPackageVersion["resource"];

const HARD_MAX_MANIFEST_BYTES = 256 * 1024 * 1024;
const HARD_MAX_MANIFEST_ENTRIES = 5_000_000;
const HARD_MAX_MANIFEST_NESTING = 512;
const HARD_MAX_WORKSPACES = 100_000;
const HARD_MAX_DIAGNOSTICS = 10_000;
const HARD_MAX_CANDIDATES = 100_000;
const HARD_MAX_EVIDENCE_PER_VERSION = 100_000;
const READ_CHUNK_BYTES = 64 * 1024;

class ManifestResourceLimitExceeded extends Error {
	readonly resource: LimitedResource;

	constructor(resource: LimitedResource) {
		super(resource);
		this.resource = resource;
	}
}

class UnsupportedLockfile extends Error {}

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function numericVersion(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function versionFromLocator(locator: string, packageName: string): string | null {
	const normalized = locator.startsWith("/") ? locator.slice(1) : locator;
	const modernPrefix = `${packageName}@`;
	if (normalized.startsWith(modernPrefix)) {
		let version = normalized.slice(modernPrefix.length).split("(", 1)[0] ?? "";
		if (version.startsWith("npm:")) version = version.slice("npm:".length);
		return version.length > 0 ? version : null;
	}
	const legacyPrefix = `${packageName}/`;
	if (!normalized.startsWith(legacyPrefix)) return null;
	const version = normalized.slice(legacyPrefix.length).split("_", 1)[0] ?? "";
	return version.length > 0 ? version : null;
}

function workspaceLocator(selector: string): { name: string; path: string } | null {
	const marker = "@workspace:";
	const markerIndex = selector.indexOf(marker);
	if (markerIndex < 1) return null;
	const name = selector.slice(0, markerIndex);
	const path = selector.slice(markerIndex + marker.length).split("(", 1)[0] ?? "";
	return name.length > 0 && path.length > 0 ? { name, path } : null;
}

function evidence(
	manager: JavaScriptPackageManager,
	lockfile: string,
	locator: string,
	integrity: string | null,
	workspace: boolean,
): InstalledPackageEvidence {
	return { manager, lockfile, locator, integrity, workspace };
}

function jsonNesting(text: string): number {
	let depth = 0;
	let maximum = 0;
	let quote: '"' | "'" | null = null;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index] ?? "";
		const next = text[index + 1] ?? "";
		if (lineComment) {
			if (character === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				blockComment = false;
				index++;
			}
			continue;
		}
		if (quote !== null) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = null;
			continue;
		}
		if (character === "/" && next === "/") {
			lineComment = true;
			index++;
			continue;
		}
		if (character === "/" && next === "*") {
			blockComment = true;
			index++;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === "{" || character === "[") {
			depth++;
			maximum = Math.max(maximum, depth);
		} else if (character === "}" || character === "]") {
			depth = Math.max(0, depth - 1);
		}
	}
	return maximum;
}

function yamlNesting(text: string): number {
	const indentation: number[] = [];
	let maximum = 0;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*(?:#.*)?$/.test(line)) continue;
		const width = line.match(/^[ \t]*/)?.[0].replaceAll("\t", "  ").length ?? 0;
		while (indentation.length > 0 && width <= (indentation.at(-1) ?? 0)) indentation.pop();
		indentation.push(width);
		maximum = Math.max(maximum, indentation.length + jsonNesting(line));
	}
	return maximum;
}

class ResolutionContext {
	private bytesRead = 0;
	private entriesRead = 0;
	private diagnosticsRead = 0;
	private readonly workspaces = new Set<string>();
	private readonly root: string;
	readonly bounds: InstalledPackageVersionBounds;

	constructor(projectRoot: string, bounds: InstalledPackageVersionBounds) {
		this.root = realpathSync(resolve(projectRoot));
		this.bounds = bounds;
	}

	touchEntry(): void {
		this.entriesRead++;
		if (this.entriesRead > this.bounds.maxManifestEntries) throw new ManifestResourceLimitExceeded("manifest-entries");
	}

	reportDiagnostics(count: number): void {
		this.diagnosticsRead += count;
		if (this.diagnosticsRead > this.bounds.maxDiagnostics) throw new ManifestResourceLimitExceeded("diagnostics");
	}

	touchWorkspace(workspacePath: string): void {
		const normalized = workspacePath === "" ? "." : workspacePath.replaceAll("\\", "/");
		if (this.workspaces.has(normalized)) return;
		this.workspaces.add(normalized);
		if (this.workspaces.size > this.bounds.maxWorkspaces) throw new ManifestResourceLimitExceeded("workspaces");
	}

	private projectPath(relativePath: string): string {
		if (isAbsolute(relativePath)) throw new Error("manifest path is absolute");
		const absolutePath = resolve(this.root, relativePath);
		const relativePathFromRoot = relative(this.root, absolutePath);
		if (relativePathFromRoot === ".." || relativePathFromRoot.startsWith(`..${sep}`) || isAbsolute(relativePathFromRoot)) {
			throw new Error("manifest path escapes project root");
		}
		if (!existsSync(absolutePath)) return absolutePath;
		const realPath = realpathSync(absolutePath);
		const realPathFromRoot = relative(this.root, realPath);
		if (realPathFromRoot === ".." || realPathFromRoot.startsWith(`..${sep}`) || isAbsolute(realPathFromRoot)) {
			throw new Error("manifest symlink escapes project root");
		}
		return realPath;
	}

	readProjectFile(relativePath: string, syntax: ManifestSyntax): string {
		const descriptor = openSync(this.projectPath(relativePath), "r");
		try {
			const stat = fstatSync(descriptor);
			if (!stat.isFile()) throw new Error("manifest is not a regular file");
			const remaining = this.bounds.maxManifestBytes - this.bytesRead;
			if (stat.size > remaining) throw new ManifestResourceLimitExceeded("manifest-bytes");
			const chunks: Buffer[] = [];
			let total = 0;
			let bytesRead: number;
			do {
				const capacity = Math.min(READ_CHUNK_BYTES, remaining - total + 1);
				const chunk = Buffer.allocUnsafe(capacity);
				bytesRead = readSync(descriptor, chunk, 0, capacity, null);
				total += bytesRead;
				if (total > remaining) throw new ManifestResourceLimitExceeded("manifest-bytes");
				if (bytesRead > 0) chunks.push(chunk.subarray(0, bytesRead));
			} while (bytesRead > 0);
			this.bytesRead += total;
			const text = Buffer.concat(chunks, total).toString("utf8");
			const nesting = syntax === "json" ? jsonNesting(text) : yamlNesting(text);
			if (nesting > this.bounds.maxManifestNesting) throw new ManifestResourceLimitExceeded("manifest-nesting");
			return text;
		} finally {
			closeSync(descriptor);
		}
	}

	workspaceVersion(workspacePath: string, packageName: string, lockfile: string, manager: JavaScriptPackageManager): ParsedEvidence | null {
		this.touchWorkspace(workspacePath);
		const normalized = workspacePath === "." || workspacePath === "" ? "package.json" : join(workspacePath, "package.json");
		const manifestPath = this.projectPath(normalized);
		if (!existsSync(manifestPath)) return null;
		const text = this.readProjectFile(normalized, "json");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.reportDiagnostics(1);
			throw new Error("invalid workspace package manifest");
		}
		this.touchEntry();
		if (!isRecord(parsed) || stringField(parsed, "name") !== packageName) return null;
		const version = stringField(parsed, "version");
		if (version === null) return null;
		return { version, evidence: evidence(manager, lockfile, workspacePath, null, true) };
	}
}

function parseJson(text: string, context: ResolutionContext): unknown {
	try {
		return JSON.parse(text);
	} catch {
		context.reportDiagnostics(1);
		throw new Error("invalid JSON lockfile");
	}
}

function parseNpmLock(text: string, lockfile: string, packageName: string, context: ResolutionContext): ParsedEvidence[] {
	const parsed = parseJson(text, context);
	if (!isRecord(parsed)) throw new Error("lockfile root is not an object");
	const lockfileVersion = parsed.lockfileVersion;
	if (lockfileVersion !== 2 && lockfileVersion !== 3) throw new UnsupportedLockfile();
	if (!isRecord(parsed.packages)) throw new Error("packages is missing");
	const results: ParsedEvidence[] = [];
	for (const [locator, rawEntry] of Object.entries(parsed.packages)) {
		context.touchEntry();
		if (!isRecord(rawEntry)) continue;
		const workspace = !locator.includes("node_modules");
		if (workspace) context.touchWorkspace(locator);
		const declaredName = stringField(rawEntry, "name");
		const isRequestedWorkspace = workspace && declaredName === packageName;
		const isInstalledEntry = locator === `node_modules/${packageName}` || locator.endsWith(`/node_modules/${packageName}`);
		if (!isRequestedWorkspace && !isInstalledEntry) continue;
		let version = stringField(rawEntry, "version");
		if (version === null && rawEntry.link === true) {
			const target = stringField(rawEntry, "resolved");
			const targetEntry = target ? parsed.packages[target] : undefined;
			if (isRecord(targetEntry)) version = stringField(targetEntry, "version");
		}
		if (version === null) continue;
		results.push({
			version,
			evidence: evidence("npm", lockfile, locator, stringField(rawEntry, "integrity"), workspace || rawEntry.link === true),
		});
	}
	return results;
}

function parsePnpmLock(text: string, lockfile: string, packageName: string, context: ResolutionContext): ParsedEvidence[] {
	const document = parseDocument(text);
	context.reportDiagnostics(document.errors.length + document.warnings.length);
	if (document.errors.length > 0) throw new Error("invalid pnpm YAML");
	const parsed: unknown = document.toJS({ maxAliasCount: Math.min(context.bounds.maxManifestEntries, 1_000) });
	if (!isRecord(parsed)) throw new Error("lockfile root is not an object");
	const lockfileVersion = numericVersion(parsed.lockfileVersion);
	if (lockfileVersion === null || lockfileVersion < 5.3 || lockfileVersion >= 10) throw new UnsupportedLockfile();
	if (!isRecord(parsed.packages) && !isRecord(parsed.importers)) throw new Error("packages and importers are missing");
	const results: ParsedEvidence[] = [];
	if (isRecord(parsed.importers)) {
		for (const workspacePath of Object.keys(parsed.importers)) {
			context.touchEntry();
			const workspace = context.workspaceVersion(workspacePath, packageName, lockfile, "pnpm");
			if (workspace !== null) results.push(workspace);
		}
	}
	for (const [locator, rawEntry] of Object.entries(isRecord(parsed.packages) ? parsed.packages : {})) {
		context.touchEntry();
		const version = versionFromLocator(locator, packageName);
		if (version === null) continue;
		const integrity = isRecord(rawEntry) && isRecord(rawEntry.resolution) ? stringField(rawEntry.resolution, "integrity") : null;
		results.push({ version, evidence: evidence("pnpm", lockfile, locator, integrity, false) });
	}
	return results;
}

function parseYarnLock(text: string, lockfile: string, packageName: string, context: ResolutionContext): ParsedEvidence[] {
	let parsed: unknown;
	try {
		parsed = parseSyml(text);
	} catch {
		context.reportDiagnostics(1);
		throw new Error("invalid Yarn lockfile");
	}
	if (!isRecord(parsed)) throw new Error("lockfile root is not an object");
	const metadata = parsed.__metadata;
	if (metadata !== undefined) {
		if (!isRecord(metadata)) throw new Error("invalid Yarn metadata");
		const version = numericVersion(metadata.version);
		if (version === null || version < 4 || version > 8) throw new UnsupportedLockfile();
	}
	const results: ParsedEvidence[] = [];
	for (const [locator, rawEntry] of Object.entries(parsed)) {
		if (locator === "__metadata") continue;
		context.touchEntry();
		if (!isRecord(rawEntry)) continue;
		const selectors = locator.split(",").map((selector) => selector.trim());
		for (const selector of selectors) {
			const workspace = workspaceLocator(selector);
			if (workspace === null) continue;
			context.touchWorkspace(workspace.path);
			if (workspace.name !== packageName) continue;
			const candidate = context.workspaceVersion(workspace.path, packageName, lockfile, "yarn");
			if (candidate !== null) results.push(candidate);
		}
		if (!selectors.some((selector) => versionFromLocator(selector, packageName) !== null)) continue;
		const version = stringField(rawEntry, "version");
		if (version === null || selectors.some((selector) => workspaceLocator(selector)?.name === packageName)) continue;
		results.push({
			version,
			evidence: evidence("yarn", lockfile, locator, stringField(rawEntry, "integrity") ?? stringField(rawEntry, "checksum"), false),
		});
	}
	return results;
}

function parseBunLock(text: string, lockfile: string, packageName: string, context: ResolutionContext): ParsedEvidence[] {
	const errors: ParseError[] = [];
	const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
	context.reportDiagnostics(errors.length);
	if (errors.length > 0 || !isRecord(parsed)) throw new Error("invalid Bun lockfile");
	if (parsed.lockfileVersion !== 1) throw new UnsupportedLockfile();
	if (!isRecord(parsed.packages)) throw new Error("packages is missing");
	const results: ParsedEvidence[] = [];
	if (isRecord(parsed.workspaces)) {
		for (const [workspacePath, rawWorkspace] of Object.entries(parsed.workspaces)) {
			context.touchEntry();
			context.touchWorkspace(workspacePath);
			if (isRecord(rawWorkspace) && stringField(rawWorkspace, "name") === packageName) {
				const version = stringField(rawWorkspace, "version");
				if (version !== null) {
					results.push({ version, evidence: evidence("bun", lockfile, workspacePath, null, true) });
					continue;
				}
			}
			const workspace = context.workspaceVersion(workspacePath, packageName, lockfile, "bun");
			if (workspace !== null) results.push(workspace);
		}
	}
	for (const [locator, rawEntry] of Object.entries(parsed.packages)) {
		context.touchEntry();
		if (!Array.isArray(rawEntry) || typeof rawEntry[0] !== "string") continue;
		const version = versionFromLocator(rawEntry[0], packageName);
		if (version === null) continue;
		const integrity = typeof rawEntry[3] === "string" && rawEntry[3].length > 0 ? rawEntry[3] : null;
		results.push({ version, evidence: evidence("bun", lockfile, locator, integrity, false) });
	}
	return results;
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

function resourceLimitOutcome(error: ManifestResourceLimitExceeded, bounds: InstalledPackageVersionBounds): InstalledPackageVersionOutcome {
	const limits: Record<LimitedResource, number> = {
		"manifest-bytes": bounds.maxManifestBytes,
		"manifest-entries": bounds.maxManifestEntries,
		"manifest-nesting": bounds.maxManifestNesting,
		workspaces: bounds.maxWorkspaces,
		diagnostics: bounds.maxDiagnostics,
	};
	return { status: "oversized", resource: error.resource, limit: limits[error.resource] };
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
