import type { PackageSourceIndexEntry, PackageSourceIndexKey } from "../domain/package-source-index.ts";
import type { PackageSourceIndexPort } from "../ports/package-source-index-port.ts";

const DEFAULT_MAX_ENTRIES = 10_000;

function keyOf(key: PackageSourceIndexKey): string {
	return `${key.ecosystem}/${key.registry ?? ""}/${key.name}/${key.resolvedVersion}`;
}

export interface InMemoryPackageSourceIndexOptions {
	readonly maxEntries?: number;
}

/** In-memory PackageSourceIndexPort -- does not survive a daemon restart, matching how MutationHistoryPort/SymbolGraphPort both started before a durable SQLite variant existed. Oldest-recorded entry evicted first once maxEntries is exceeded, never a caller-chosen one -- Map insertion order gives this for free once record() re-inserts a refreshed key at the end. */
export class InMemoryPackageSourceIndex implements PackageSourceIndexPort {
	private readonly entries = new Map<string, PackageSourceIndexEntry>();
	private readonly maxEntries: number;

	constructor(options: InMemoryPackageSourceIndexOptions = {}) {
		const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError("maxEntries must be a positive safe integer");
		this.maxEntries = maxEntries;
	}

	async record(entry: PackageSourceIndexEntry): Promise<void> {
		const key = keyOf(entry);
		this.entries.delete(key);
		this.entries.set(key, entry);
		while (this.entries.size > this.maxEntries) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey === undefined) break;
			this.entries.delete(oldestKey);
		}
	}

	async list(): Promise<readonly PackageSourceIndexEntry[]> {
		return Array.from(this.entries.values());
	}

	async remove(key: PackageSourceIndexKey): Promise<boolean> {
		return this.entries.delete(keyOf(key));
	}
}
