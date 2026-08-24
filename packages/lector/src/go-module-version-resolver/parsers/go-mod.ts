export interface ParsedGoModRequire {
	readonly modulePath: string;
	readonly version: string;
	readonly locator: string;
}

export interface ParsedGoModReplace {
	readonly oldPath: string;
	/** null means the replace applies to every version of oldPath, not just one. */
	readonly oldVersion: string | null;
	readonly newPath: string;
	/** null for a local filesystem replacement -- go.mod's own grammar never allows a version alongside one. */
	readonly newVersion: string | null;
	readonly locator: string;
}

export interface ParsedGoMod {
	readonly modulePath: string | null;
	readonly requires: readonly ParsedGoModRequire[];
	readonly replaces: readonly ParsedGoModReplace[];
}

function stripLineComment(line: string): string {
	const index = line.indexOf("//");
	return index === -1 ? line : line.slice(0, index);
}

/** A require line's own text, kept verbatim (including a trailing `// indirect`) as the locator -- go.mod's grammar puts no other meaningful content after the version. */
function parseRequireLine(line: string, locator: string): ParsedGoModRequire | null {
	const parts = stripLineComment(line).trim().split(/\s+/);
	if (parts.length < 2) return null;
	const [modulePath, version] = parts;
	if (!modulePath || !version) return null;
	return { modulePath, version, locator };
}

/** `oldPath[ oldVersion] => newPath[ newVersion]` -- the shape shared by both the single-line `replace ...` statement and each line inside a grouped `replace (...)` block. */
function parseReplaceLine(line: string, locator: string): ParsedGoModReplace | null {
	const stripped = stripLineComment(line).trim();
	const arrowIndex = stripped.indexOf("=>");
	if (arrowIndex === -1) return null;
	const left = stripped.slice(0, arrowIndex).trim().split(/\s+/).filter(Boolean);
	const right = stripped
		.slice(arrowIndex + 2)
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (left.length === 0 || right.length === 0) return null;
	const [oldPath, oldVersion] = left;
	const [newPath, newVersion] = right;
	if (!oldPath || !newPath) return null;
	return { oldPath, oldVersion: oldVersion ?? null, newPath, newVersion: newVersion ?? null, locator };
}

/**
 * Parses a real go.mod's own module declaration, every `require` (single-line and grouped block
 * form), and every `replace` (single-line and grouped block form) -- a lightweight, purpose-built
 * line scanner rather than a full modfile grammar, sufficient for the fields this resolver needs.
 */
export function parseGoMod(text: string): ParsedGoMod {
	const lines = text.split("\n");
	let modulePath: string | null = null;
	const requires: ParsedGoModRequire[] = [];
	const replaces: ParsedGoModReplace[] = [];
	let blockKind: "require" | "replace" | null = null;

	for (const rawLine of lines) {
		const line = stripLineComment(rawLine).trim();
		if (blockKind !== null) {
			if (line === ")") {
				blockKind = null;
				continue;
			}
			if (line.length === 0) continue;
			if (blockKind === "require") {
				const parsed = parseRequireLine(line, rawLine.trim());
				if (parsed) requires.push(parsed);
			} else {
				const parsed = parseReplaceLine(line, rawLine.trim());
				if (parsed) replaces.push(parsed);
			}
			continue;
		}
		if (line.length === 0) continue;
		if (line.startsWith("module ")) {
			modulePath = line.slice("module ".length).trim();
			continue;
		}
		if (line === "require (") {
			blockKind = "require";
			continue;
		}
		if (line === "replace (") {
			blockKind = "replace";
			continue;
		}
		if (line.startsWith("require ")) {
			const parsed = parseRequireLine(line.slice("require ".length), line);
			if (parsed) requires.push(parsed);
			continue;
		}
		if (line.startsWith("replace ")) {
			const parsed = parseReplaceLine(line.slice("replace ".length), line);
			if (parsed) replaces.push(parsed);
		}
	}

	return { modulePath, requires, replaces };
}
