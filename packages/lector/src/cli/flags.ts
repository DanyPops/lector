import { PACKAGE_ECOSYSTEMS, type PackageEcosystem } from "../package-source/package-source.ts";
import type { ResponseFormat } from "../workspace/response-format.ts";

/**
 * A domain-agnostic flag-parsing DSL for a Vehicle-backed daemon CLI's own argv handling --
 * reusable by any future daemon CLI, not lector-specific. The 3 ecosystem-related parsers below
 * are the only real exceptions (they need PackageEcosystem), kept here anyway since every other
 * flag parser in the CLI already lives alongside them.
 */
export function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

export function collectFlagValues(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === flag) {
			const value = args[index + 1];
			if (value === undefined) fail(`${flag} requires a value`);
			values.push(value);
			index++;
		}
	}
	return values;
}

export function flagValue(args: string[], flag: string): string | undefined {
	return collectFlagValues(args, flag).at(-1);
}

export function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

export function positiveIntegerFlag(args: string[], flag: string, environmentValue?: string): number | undefined {
	const raw = flagValue(args, flag) ?? environmentValue;
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) fail(`${flag} must be a positive safe integer`);
	return value;
}

export function nonNegativeIntegerFlag(args: string[], flag: string, environmentValue?: string): number | undefined {
	const raw = flagValue(args, flag) ?? environmentValue;
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) fail(`${flag} must be a non-negative safe integer`);
	return value;
}

export function requiredIntFlag(flags: string[], flag: string): number {
	const raw = flagValue(flags, flag);
	const parsed = Number(raw);
	if (raw === undefined || !Number.isInteger(parsed)) fail(`${flag} <n> is required`);
	return parsed;
}

export function parseWorkspacePathFlag(raw: string): { id: string; dir: string } {
	const separatorIndex = raw.indexOf("=");
	if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
		fail(`--workspace-path expects <id>=<dir>, got "${raw}"`);
	}
	return { id: raw.slice(0, separatorIndex), dir: raw.slice(separatorIndex + 1) };
}

/** "<path>:<line>:<character>" -- split from the right so a path containing colons (e.g. a Windows drive letter) is never misparsed as part of the position. */
export function parseAnchorFlag(value: string): { path: string; line: number; character: number } {
	const lastColon = value.lastIndexOf(":");
	const secondLastColon = lastColon === -1 ? -1 : value.lastIndexOf(":", lastColon - 1);
	const path = secondLastColon === -1 ? "" : value.slice(0, secondLastColon);
	const line = secondLastColon === -1 ? Number.NaN : Number(value.slice(secondLastColon + 1, lastColon));
	const character = lastColon === -1 ? Number.NaN : Number(value.slice(lastColon + 1));
	if (!path || !Number.isInteger(line) || !Number.isInteger(character)) fail(`invalid --anchor value "${value}"; expected <path>:<line>:<character>`);
	return { path, line, character };
}

export function parseResponseFormat(flags: string[]): ResponseFormat | undefined {
	const value = flagValue(flags, "--response-format");
	if (value === undefined) return undefined;
	if (value !== "concise" && value !== "detailed") fail(`--response-format must be "concise" or "detailed", got "${value}"`);
	return value;
}

export function parseSymbolEdgeKind(flags: string[]): "calls" | "references" | "contains" | undefined {
	const raw = flagValue(flags, "--kind");
	if (raw === undefined) return undefined;
	if (raw !== "calls" && raw !== "references" && raw !== "contains") fail(`--kind must be calls, references, or contains; got "${raw}"`);
	return raw;
}

/** Parses "owner/repo[@ref]" into the explicit fields repo.fetch expects; --host overrides the "github.com" default. */
export function parseRepoSpec(spec: string, host: string): { host: string; owner: string; repo: string; ref: string | null } {
	const [ownerRepo, ref] = spec.split("@");
	const [owner, repo] = (ownerRepo ?? "").split("/");
	if (!owner || !repo) fail(`repo spec must be "<owner>/<repo>[@ref]", got "${spec}"`);
	return { host, owner, repo, ref: ref ?? null };
}

export function parsePosition(line: string | undefined, character: string | undefined): { line: number; character: number } {
	const parsedLine = Number(line);
	const parsedCharacter = Number(character);
	if (!line || !character || !Number.isInteger(parsedLine) || !Number.isInteger(parsedCharacter)) {
		fail("expected <line> <character> as integers");
	}
	return { line: parsedLine, character: parsedCharacter };
}

// A real type guard, not an assertion -- widens the allowed-values array to readonly string[]
// so .includes() itself needs no cast, then lets TS narrow `value` for free at every call site.
export function isPackageEcosystem(value: string): value is PackageEcosystem {
	return (PACKAGE_ECOSYSTEMS as readonly string[]).includes(value);
}

export function parseEcosystemFlag(flags: string[]): PackageEcosystem | undefined {
	const raw = flagValue(flags, "--ecosystem");
	if (raw === undefined) return undefined;
	if (!isPackageEcosystem(raw)) fail(`--ecosystem must be one of ${PACKAGE_ECOSYSTEMS.join(", ")}; got "${raw}"`);
	return raw;
}

export function requireEcosystem(value: string | undefined): PackageEcosystem {
	if (value === undefined || !isPackageEcosystem(value)) fail(`ecosystem must be one of ${PACKAGE_ECOSYSTEMS.join(", ")}; got "${value ?? ""}"`);
	return value;
}

export function requireAnnotationFields(flags: string[]): {
	subtype: string;
	title: string;
	body: string;
	anchors: { path: string; line: number; character: number }[];
} {
	const subtype = flagValue(flags, "--subtype");
	const title = flagValue(flags, "--title");
	const body = flagValue(flags, "--body");
	if (!subtype || !title || body === undefined) fail("requires --subtype, --title, and --body");
	const anchors = collectFlagValues(flags, "--anchor").map(parseAnchorFlag);
	return { subtype, title, body, anchors };
}
