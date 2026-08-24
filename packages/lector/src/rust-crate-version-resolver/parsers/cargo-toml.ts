export interface ParsedCargoTomlGitSpec {
	readonly url: string;
	readonly rev: string | null;
	readonly tag: string | null;
	readonly branch: string | null;
}

export interface ParsedCargoTomlDependency {
	/** The dependency's own `package = "..."` rename, when present -- the real crate name, distinct from the local key it's declared under. */
	readonly realName: string | null;
	readonly registryName: string | null;
	readonly git: ParsedCargoTomlGitSpec | null;
	readonly path: string | null;
}

export interface ParsedCargoToml {
	readonly dependencies: ReadonlyMap<string, ParsedCargoTomlDependency>;
	/** Registry name -> its own configured index URL, from `[registries]`. */
	readonly registries: ReadonlyMap<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function parseDependencyEntry(value: unknown): ParsedCargoTomlDependency {
	if (!isRecord(value)) return { realName: null, registryName: null, git: null, path: null };
	const gitUrl = stringField(value, "git");
	const git = gitUrl ? { url: gitUrl, rev: stringField(value, "rev"), tag: stringField(value, "tag"), branch: stringField(value, "branch") } : null;
	return { realName: stringField(value, "package"), registryName: stringField(value, "registry"), git, path: stringField(value, "path") };
}

/** Parses a real Cargo.toml's own `[dependencies]` table (rename via `package = "..."`, an alternate `registry` reference, a `git`/`rev`/`tag`/`branch` spec, or a local `path`) and its `[registries]` table (registry name -> index URL). Every other table (`[dev-dependencies]`, `[build-dependencies]`, `[package]`, ...) is out of scope -- a real installed dependency is what package.resolveSource asks about, and `[dependencies]` is where that's declared. */
export function parseCargoToml(text: string): ParsedCargoToml {
	const parsed = Bun.TOML.parse(text);
	const dependencies = new Map<string, ParsedCargoTomlDependency>();
	if (isRecord(parsed) && isRecord(parsed.dependencies)) {
		for (const [name, value] of Object.entries(parsed.dependencies)) dependencies.set(name, parseDependencyEntry(value));
	}
	const registries = new Map<string, string>();
	if (isRecord(parsed) && isRecord(parsed.registries)) {
		for (const [name, value] of Object.entries(parsed.registries)) {
			if (isRecord(value)) {
				const index = stringField(value, "index");
				if (index !== null) registries.set(name, index);
			}
		}
	}
	return { dependencies, registries };
}
