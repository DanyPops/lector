import type { InstalledPackageEvidence, JavaScriptPackageManager } from "../installed-package-version.ts";

/** One (version, evidence) pair a single lockfile-format parser found for the requested package -- the only shape every parser and ResolutionContext.workspaceVersion agree on. */
export interface ParsedEvidence {
	readonly version: string;
	readonly evidence: InstalledPackageEvidence;
}

/** Raised when a lockfile exists but its own declared format version is outside what a parser can honestly interpret (e.g. a pre-v2 npm lockfile, or a Yarn Classic v1 lockfile) -- distinct from a genuinely corrupt/unparseable file. */
export class UnsupportedLockfile extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function numericVersion(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function versionFromLocator(locator: string, packageName: string): string | null {
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

export function workspaceLocator(selector: string): { name: string; path: string } | null {
	const marker = "@workspace:";
	const markerIndex = selector.indexOf(marker);
	if (markerIndex < 1) return null;
	const name = selector.slice(0, markerIndex);
	const path = selector.slice(markerIndex + marker.length).split("(", 1)[0] ?? "";
	return name.length > 0 && path.length > 0 ? { name, path } : null;
}

export function evidence(
	manager: JavaScriptPackageManager,
	lockfile: string,
	locator: string,
	integrity: string | null,
	workspace: boolean,
): InstalledPackageEvidence {
	return { manager, lockfile, locator, integrity, workspace };
}
