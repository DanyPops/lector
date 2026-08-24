import type { PythonResolutionContext } from "../resolution-context.ts";
import { evidence, namesMatch, type ParsedPythonEvidence } from "./shared.ts";

/** A `#` starts a real comment only at line-start or preceded by whitespace -- distinct from a VCS URL's own `#egg=name` fragment, which has no preceding whitespace (pip's own parsing rule). */
function stripComment(line: string): string {
	const match = line.match(/(^|\s)#/);
	return match?.index === undefined ? line : line.slice(0, match.index + (match[1]?.length ?? 0));
}

interface VcsUrlParts {
	readonly url: string;
	readonly ref: string | null;
	readonly eggName: string | null;
}

/** Splits a `git+https://host/owner/repo.git@ref#egg=name` (or without the `#egg=` fragment) into its own real parts. */
function parseVcsUrl(raw: string): VcsUrlParts {
	const [beforeFragment, fragment] = raw.split("#", 2);
	const eggMatch = fragment?.match(/(?:^|&)egg=([^&]+)/);
	const atIndex = (beforeFragment ?? raw).lastIndexOf("@");
	// The first "@" after the scheme's own "://" is the ref separator; a bare "git+https://" has none before it.
	const schemeEnd = (beforeFragment ?? raw).indexOf("://");
	if (atIndex > schemeEnd) {
		return { url: (beforeFragment ?? raw).slice(0, atIndex), ref: (beforeFragment ?? raw).slice(atIndex + 1), eggName: eggMatch?.[1] ?? null };
	}
	return { url: beforeFragment ?? raw, ref: null, eggName: eggMatch?.[1] ?? null };
}

function parseEditableLine(rest: string, lockfile: string, line: string, packageName: string): ParsedPythonEvidence | null {
	const parts = parseVcsUrl(rest.trim());
	if (parts.eggName === null || !namesMatch(parts.eggName, packageName)) return null;
	return { version: parts.ref ?? "unknown", evidence: evidence("pip", lockfile, line, "editable", parts.url, parts.ref) };
}

/** PEP 508 direct-reference syntax: `name @ git+https://...` (or `name @ file://...`, treated the same as a direct, non-editable VCS/URL pin). */
function parseDirectReferenceLine(line: string, lockfile: string, packageName: string): ParsedPythonEvidence | null {
	const separator = line.indexOf(" @ ");
	if (separator === -1) return null;
	const name = line.slice(0, separator).trim();
	if (!namesMatch(name, packageName)) return null;
	const parts = parseVcsUrl(line.slice(separator + 3).trim());
	return { version: parts.ref ?? "unknown", evidence: evidence("pip", lockfile, line, "direct-vcs", parts.url, parts.ref) };
}

const EXACT_PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==([^\s;]+)/;

function parsePinnedLine(line: string, lockfile: string, packageName: string): ParsedPythonEvidence | null {
	const match = EXACT_PIN.exec(line);
	if (!match) return null;
	const [, name, version] = match;
	if (name === undefined || version === undefined || !namesMatch(name, packageName)) return null;
	return { version, evidence: evidence("pip", lockfile, line, "registry", null, null) };
}

/**
 * Parses a real `requirements.txt` (pip's own plain-text format) for `packageName`, under PEP 503
 * name normalization. Only an exact `==` pin, a `-e`/`--editable` line, or PEP 508 `name @ URL`
 * direct-reference syntax carries real evidence of an *actually installed* version -- a bare
 * range constraint (`requests>=2.0`) never tells us what version pip actually resolved, and is
 * deliberately not reported as evidence at all (the direct_url.json/dist-info fallback exists for
 * exactly that harder case).
 */
export function parseRequirementsTxt(text: string, lockfile: string, packageName: string, context: PythonResolutionContext): readonly ParsedPythonEvidence[] {
	const results: ParsedPythonEvidence[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		context.touchEntry();
		const line = stripComment(rawLine).trim();
		if (line.length === 0) continue;
		let entry: ParsedPythonEvidence | null = null;
		if (line.startsWith("-e ")) entry = parseEditableLine(line.slice(3), lockfile, line, packageName);
		else if (line.startsWith("--editable ")) entry = parseEditableLine(line.slice("--editable ".length), lockfile, line, packageName);
		else if (line.startsWith("-") || line.includes("://") === false) entry = parsePinnedLine(line, lockfile, packageName);
		else entry = parseDirectReferenceLine(line, lockfile, packageName) ?? parsePinnedLine(line, lockfile, packageName);
		if (entry) results.push(entry);
	}
	return results;
}
