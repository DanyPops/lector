export interface GoSumEntry {
	readonly checksum: string;
	/** True when go.sum itself declares two different content hashes for the exact same module@version -- a real corruption/tampering signal, detectable purely by parsing, independent of any network fetch. */
	readonly mismatched: boolean;
}

/**
 * Parses a real go.sum into a `module@version -> content hash` map. go.sum records two lines per
 * module@version (the module's own content hash, and a separate `/go.mod` hash for just its
 * manifest) -- only the content-hash line is kept here; the resolver verifies the module itself,
 * not its manifest in isolation.
 */
export function parseGoSum(text: string): ReadonlyMap<string, GoSumEntry> {
	const entries = new Map<string, GoSumEntry>();
	for (const line of text.split("\n")) {
		const fields = line.trim().split(/\s+/).filter(Boolean);
		if (fields.length !== 3) continue;
		const [modulePath, versionField, checksum] = fields;
		if (!modulePath || !versionField || !checksum) continue;
		if (versionField.endsWith("/go.mod")) continue;
		const key = `${modulePath}@${versionField}`;
		const existing = entries.get(key);
		if (existing) {
			entries.set(key, { checksum: existing.checksum, mismatched: existing.mismatched || existing.checksum !== checksum });
		} else {
			entries.set(key, { checksum, mismatched: false });
		}
	}
	return entries;
}
