import type { PythonResolutionContext } from "../resolution-context.ts";
import { evidence, isRecord, namesMatch, type ParsedPythonEvidence, stringField } from "./shared.ts";

interface UvSource {
	readonly registry: string | null;
	readonly editable: string | null;
	readonly virtual: string | null;
	readonly git: string | null;
	readonly rev: string | null;
}

function uvSource(value: unknown): UvSource {
	if (!isRecord(value)) return { registry: null, editable: null, virtual: null, git: null, rev: null };
	return {
		registry: stringField(value, "registry"),
		editable: stringField(value, "editable"),
		virtual: stringField(value, "virtual"),
		git: stringField(value, "git"),
		rev: stringField(value, "rev") ?? stringField(value, "commit"),
	};
}

/** Parses a real `uv.lock` (TOML, uv's own lockfile) for every `[[package]]` entry matching `packageName`, under PEP 503 name normalization. The lockfile's own root/`virtual` entry (the project itself, not a dependency) is skipped -- it has no meaningful "installed version" to resolve source for. */
export function parseUvLock(text: string, lockfile: string, packageName: string, context: PythonResolutionContext): readonly ParsedPythonEvidence[] {
	const parsed = context.parseToml(text);
	if (!isRecord(parsed) || !Array.isArray(parsed.package)) return [];
	const results: ParsedPythonEvidence[] = [];
	for (const entry of parsed.package) {
		context.touchEntry();
		if (!isRecord(entry)) continue;
		const name = stringField(entry, "name");
		const version = stringField(entry, "version");
		if (name === null || version === null || !namesMatch(name, packageName)) continue;
		const source = uvSource(entry.source);
		if (source.virtual !== null) continue; // the project's own root entry, not an installed dependency
		if (source.editable !== null) {
			results.push({ version, evidence: evidence("uv", lockfile, name, "editable", source.editable, null) });
		} else if (source.git !== null) {
			results.push({ version, evidence: evidence("uv", lockfile, name, "direct-vcs", source.git, source.rev) });
		} else {
			results.push({ version, evidence: evidence("uv", lockfile, name, "registry", null, null) });
		}
	}
	return results;
}
