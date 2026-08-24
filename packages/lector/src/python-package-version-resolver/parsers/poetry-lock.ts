import type { InstalledPythonEvidence } from "../installed-package-version.ts";
import type { PythonResolutionContext } from "../resolution-context.ts";
import { evidence, isRecord, namesMatch, type ParsedPythonEvidence, stringField } from "./shared.ts";

function poetryEvidence(lockfile: string, name: string, source: unknown): InstalledPythonEvidence {
	if (!isRecord(source)) return evidence("poetry", lockfile, name, "registry", null, null);
	const type = stringField(source, "type");
	const url = stringField(source, "url");
	if (type === "git") return evidence("poetry", lockfile, name, "direct-vcs", url, stringField(source, "resolved_reference"));
	if (type === "directory" || type === "file") return evidence("poetry", lockfile, name, "editable", url, null);
	return evidence("poetry", lockfile, name, "registry", null, null);
}

/** Parses a real `poetry.lock` (TOML) for every `[[package]]` entry matching `packageName`, under PEP 503 name normalization. Poetry legitimately locks two different versions of the same package for different extras/environment markers (e.g. main vs. a dev-only extra) -- every matching entry is returned, letting the caller's own merge step detect real version ambiguity rather than this parser silently picking one. */
export function parsePoetryLock(text: string, lockfile: string, packageName: string, context: PythonResolutionContext): readonly ParsedPythonEvidence[] {
	const parsed = context.parseToml(text);
	if (!isRecord(parsed) || !Array.isArray(parsed.package)) return [];
	const results: ParsedPythonEvidence[] = [];
	for (const entry of parsed.package) {
		context.touchEntry();
		if (!isRecord(entry)) continue;
		const name = stringField(entry, "name");
		const version = stringField(entry, "version");
		if (name === null || version === null || !namesMatch(name, packageName)) continue;
		results.push({ version, evidence: poetryEvidence(lockfile, name, entry.source) });
	}
	return results;
}
