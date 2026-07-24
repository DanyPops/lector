import type { Database } from "bun:sqlite";
import { type Migration, openSqliteWithPragmas } from "@danypops/daemon-kit/storage";
import type { ContentHash } from "../domain/content-hash.ts";
import type { ContentCacheEntry, ContentCachePort, ContentSymbol } from "../ports/content-cache-port.ts";

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		up: (db) => {
			db.exec("CREATE TABLE content_cache (hash TEXT PRIMARY KEY, raw_content TEXT, symbols_json TEXT)");
		},
	},
];

interface ContentCacheRow {
	raw_content: string | null;
	symbols_json: string | null;
}

/**
 * SQLite-backed ContentCachePort (via daemon-kit's migration-runner
 * bootstrap -- same pragmas/versioning as every other @danypops daemon,
 * not a bespoke SQLite setup). One row per ContentHash; a put for one lens
 * only ever updates that lens's column (SQLite upsert with a targeted SET
 * clause), never clobbering a lens already recorded for the same hash --
 * this is what makes the single-row-per-hash design actually deliver "one
 * shared store," not two columns that happen to live in the same table but
 * still get overwritten independently.
 *
 * This is Lector's first genuinely durable state: unlike everything else
 * built so far (in-memory registries, live LSP/tree-sitter queries), a
 * cache entry written here is still present after the daemon restarts,
 * pointed at the same database file (test: content-cache-port-conformance
 * runs this exact "survives reopen" case against both adapters).
 */
export class SqliteContentCache implements ContentCachePort {
	private readonly db: Database;

	constructor(path: string) {
		this.db = openSqliteWithPragmas(path, { migrations: MIGRATIONS });
	}

	async get(hash: ContentHash): Promise<ContentCacheEntry | undefined> {
		const row = this.db.query("SELECT raw_content, symbols_json FROM content_cache WHERE hash = ?").get(hash) as ContentCacheRow | null;
		if (!row) return undefined;
		const entry: { rawContent?: string; symbols?: readonly ContentSymbol[] } = {};
		if (row.raw_content !== null) entry.rawContent = row.raw_content;
		if (row.symbols_json !== null) entry.symbols = JSON.parse(row.symbols_json) as ContentSymbol[];
		return entry;
	}

	async putRawContent(hash: ContentHash, content: string): Promise<void> {
		this.db
			.query("INSERT INTO content_cache (hash, raw_content) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET raw_content = excluded.raw_content")
			.run(hash, content);
	}

	async putSymbols(hash: ContentHash, symbols: readonly ContentSymbol[]): Promise<void> {
		this.db
			.query("INSERT INTO content_cache (hash, symbols_json) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET symbols_json = excluded.symbols_json")
			.run(hash, JSON.stringify(symbols));
	}

	close(): void {
		this.db.close();
	}
}
