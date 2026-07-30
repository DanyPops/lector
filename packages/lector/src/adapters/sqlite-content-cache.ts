import type { Database } from "bun:sqlite";
import { type Migration, openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import type { ContentHash } from "../domain/content-hash.ts";
import type { ContentCacheEntry, ContentCachePort, ContentSymbol } from "../ports/content-cache-port.ts";

const DEFAULT_MAX_ENTRIES = 5_000;

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		up: (db) => {
			db.exec("CREATE TABLE content_cache (hash TEXT PRIMARY KEY, raw_content TEXT, symbols_json TEXT)");
		},
	},
	{
		version: 2,
		up: (db) => {
			// Recency bound for eviction. Defaults to 0 for rows that predate this column, so they
			// are treated as least-recently-used (evicted first) rather than freshly accessed.
			db.exec("ALTER TABLE content_cache ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0");
			db.exec("CREATE INDEX content_cache_last_accessed_at_idx ON content_cache (last_accessed_at)");
		},
	},
];

interface ContentCacheRow {
	raw_content: string | null;
	symbols_json: string | null;
}

export interface SqliteContentCacheOptions {
	/** Row-count budget. Once exceeded, the least-recently-accessed rows are deleted down to this count. Default 5000. */
	readonly maxEntries?: number;
	/** Clock, injectable for tests. Defaults to Date.now. */
	readonly now?: () => number;
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
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor(path: string, options: SqliteContentCacheOptions = {}) {
		this.db = openSqliteWithPragmas(path, { migrations: MIGRATIONS });
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.now = options.now ?? Date.now;
	}

	async get(hash: ContentHash): Promise<ContentCacheEntry | undefined> {
		const row = this.db.query("SELECT raw_content, symbols_json FROM content_cache WHERE hash = ?").get(hash) as ContentCacheRow | null;
		if (!row) return undefined;
		this.db.query("UPDATE content_cache SET last_accessed_at = ? WHERE hash = ?").run(this.now(), hash);
		const entry: { rawContent?: string; symbols?: readonly ContentSymbol[] } = {};
		if (row.raw_content !== null) entry.rawContent = row.raw_content;
		if (row.symbols_json !== null) entry.symbols = JSON.parse(row.symbols_json) as ContentSymbol[];
		return entry;
	}

	async putRawContent(hash: ContentHash, content: string): Promise<void> {
		this.db
			.query(
				"INSERT INTO content_cache (hash, raw_content, last_accessed_at) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET raw_content = excluded.raw_content, last_accessed_at = excluded.last_accessed_at",
			)
			.run(hash, content, this.now());
		this.evictOverBudget();
	}

	async putSymbols(hash: ContentHash, symbols: readonly ContentSymbol[]): Promise<void> {
		this.db
			.query(
				"INSERT INTO content_cache (hash, symbols_json, last_accessed_at) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET symbols_json = excluded.symbols_json, last_accessed_at = excluded.last_accessed_at",
			)
			.run(hash, JSON.stringify(symbols), this.now());
		this.evictOverBudget();
	}

	/** Deletes the least-recently-accessed rows down to maxEntries, when over budget. Runs after every write rather than on a timer -- the table's expected steady-state size is the budget itself, so each check is cheap. */
	private evictOverBudget(): void {
		const { count } = this.db.query("SELECT COUNT(*) AS count FROM content_cache").get() as { count: number };
		const over = count - this.maxEntries;
		if (over <= 0) return;
		this.db.query("DELETE FROM content_cache WHERE hash IN (SELECT hash FROM content_cache ORDER BY last_accessed_at ASC, rowid ASC LIMIT ?)").run(over);
	}

	close(): void {
		this.db.close();
	}
}
