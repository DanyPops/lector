import type { InstalledPythonEvidence, PythonInstallKind, PythonPackageManager } from "../installed-package-version.ts";
import { normalizePythonPackageName } from "../pep503.ts";

/** One (version, evidence) pair a single lockfile-format parser found for the requested package -- the only shape every parser and the resolver's own merge step agree on. */
export interface ParsedPythonEvidence {
	readonly version: string;
	readonly evidence: InstalledPythonEvidence;
}

/** Raised when a lockfile exists but its own declared format/schema is outside what a parser can honestly interpret (e.g. a Pipfile.lock with no `_meta` at all) -- distinct from a genuinely corrupt/unparseable file. */
export class UnsupportedLockfile extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function namesMatch(candidateName: string, requestedName: string): boolean {
	return normalizePythonPackageName(candidateName) === normalizePythonPackageName(requestedName);
}

export function evidence(
	manager: PythonPackageManager,
	lockfile: string,
	locator: string,
	kind: PythonInstallKind,
	directSource: string | null,
	commit: string | null,
): InstalledPythonEvidence {
	return { manager, lockfile, locator, kind, directSource, commit };
}
