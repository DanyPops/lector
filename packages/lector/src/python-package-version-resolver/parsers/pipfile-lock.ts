import type { PythonResolutionContext } from "../resolution-context.ts";
import { evidence, isRecord, namesMatch, type ParsedPythonEvidence, stringField } from "./shared.ts";

function pinnedVersion(raw: string): string {
	return raw.startsWith("==") ? raw.slice(2) : raw;
}

function sectionEntries(section: unknown, packageName: string): readonly [string, Record<string, unknown>][] {
	if (!isRecord(section)) return [];
	return Object.entries(section).filter((pair): pair is [string, Record<string, unknown>] => isRecord(pair[1]) && namesMatch(pair[0], packageName));
}

/**
 * Parses a real `Pipfile.lock` (JSON, pipenv's own lockfile) for `packageName` across both its
 * `default` and `develop` sections, under PEP 503 name normalization. A `==`-pinned registry
 * entry's version is unwrapped to a bare semver; a git/path-sourced entry (pipenv tracks neither
 * with a real semver at all) uses its own ref, or a literal "local" placeholder, as the version
 * identity instead -- a real Pipenv limitation, not something this parser can improve on.
 */
export function parsePipfileLock(text: string, lockfile: string, packageName: string, context: PythonResolutionContext): readonly ParsedPythonEvidence[] {
	const parsed = context.parseJson(text);
	if (!isRecord(parsed)) return [];
	const results: ParsedPythonEvidence[] = [];
	for (const section of [parsed.default, parsed.develop]) {
		for (const [name, entry] of sectionEntries(section, packageName)) {
			context.touchEntry();
			const git = stringField(entry, "git");
			const path = stringField(entry, "path");
			if (git !== null) {
				const ref = stringField(entry, "ref");
				results.push({ version: ref ?? "unknown", evidence: evidence("pipenv", lockfile, name, "direct-vcs", git, ref) });
				continue;
			}
			if (path !== null) {
				results.push({ version: "local", evidence: evidence("pipenv", lockfile, name, "editable", path, null) });
				continue;
			}
			const rawVersion = stringField(entry, "version");
			if (rawVersion === null) continue;
			results.push({ version: pinnedVersion(rawVersion), evidence: evidence("pipenv", lockfile, name, "registry", null, null) });
		}
	}
	return results;
}
