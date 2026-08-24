export interface ParsedCargoLockPackage {
	readonly name: string;
	readonly version: string;
	readonly source: string | null;
	readonly checksum: string | null;
	readonly locator: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parses every `[[package]]` entry in a real Cargo.lock. Every entry is returned as-is, including a genuine duplicate name@version pair with two different checksums -- detecting that as a mismatch is the orchestrator's own job, not this parser's. */
export function parseCargoLock(text: string): readonly ParsedCargoLockPackage[] {
	const parsed = Bun.TOML.parse(text);
	if (!isRecord(parsed) || !Array.isArray(parsed.package)) return [];
	const packages: ParsedCargoLockPackage[] = [];
	for (const entry of parsed.package) {
		if (!isRecord(entry)) continue;
		const name = stringField(entry, "name");
		const version = stringField(entry, "version");
		if (name === null || version === null) continue;
		packages.push({ name, version, source: stringField(entry, "source"), checksum: stringField(entry, "checksum"), locator: `[[package]] ${name} ${version}` });
	}
	return packages;
}
