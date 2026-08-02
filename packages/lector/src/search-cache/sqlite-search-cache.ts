import type { Database } from "bun:sqlite";
import { type Migration, openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import type { TextSearchResult } from "../domain/text-search-result.ts";
import type { SearchCachePort } from "./port.ts";
import { deriveSearchCacheKey, type SearchCacheKey } from "./search-cache-key.ts";

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		up: (db) => {
			db.exec("CREATE TABLE search_cache (key TEXT PRIMARY KEY, result_json TEXT NOT NULL, expires_at INTEGER NOT NULL)");
		},
	},
];

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface SearchCacheRow {
	result_json: string;
	expires_at: number;
}

export interface SqliteSearchCacheOptions {
	readonly ttlMs?: number;
}

/**
 * SQLite-backed SearchCachePort -- survives a daemon restart, unlike InMemorySearchCache.
 * TTL is enforced by storing an explicit expires_at and filtering on read; there is no
 * background sweep of expired rows (this is a cache, not a durability guarantee -- a stale row
 * sitting unread on disk costs nothing until something actually asks for that exact key again).
 */
export class SqliteSearchCache implements SearchCachePort {
	private readonly db: Database;
	private readonly ttlMs: number;

	constructor(path: string, options: SqliteSearchCacheOptions = {}) {
		this.db = openSqliteWithPragmas(path, { migrations: MIGRATIONS });
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	}

	async get(key: SearchCacheKey): Promise<TextSearchResult | undefined> {
		const row = this.db.query("SELECT result_json, expires_at FROM search_cache WHERE key = ?").get(deriveSearchCacheKey(key)) as SearchCacheRow | null;
		if (!row) return undefined;
		if (row.expires_at <= Date.now()) return undefined;
		return JSON.parse(row.result_json) as TextSearchResult;
	}

	async set(key: SearchCacheKey, result: TextSearchResult): Promise<void> {
		this.db
			.query(
				"INSERT INTO search_cache (key, result_json, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET result_json = excluded.result_json, expires_at = excluded.expires_at",
			)
			.run(deriveSearchCacheKey(key), JSON.stringify(result), Date.now() + this.ttlMs);
	}

	close(): void {
		this.db.close();
	}
}
