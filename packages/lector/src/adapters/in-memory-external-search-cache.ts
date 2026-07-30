import { LRUCache } from "lru-cache";
import { deriveExternalSearchCacheKey, type ExternalSearchCacheKey } from "../domain/external-search-cache-key.ts";
import type { ExternalSearchCachePort } from "../ports/external-search-cache-port.ts";

const DEFAULT_MAX_ENTRIES = 100;
/** Short by design -- an external search result is a live, time-sensitive ranking (stars, npm score, code matches), not content-addressed data that "never invalidates". Long enough to dedupe a caller retrying the same query moments apart, short enough that a stale ranking never survives a real session. */
const DEFAULT_TTL_MS = 60 * 1000;

export interface InMemoryExternalSearchCacheOptions {
	readonly maxEntries?: number;
	readonly ttlMs?: number;
}

/** ExternalSearchCachePort backed by lru-cache -- same off-the-shelf choice InMemorySearchCache already made, one instance per external-search source since each has its own result type. */
export class InMemoryExternalSearchCache<T extends object> implements ExternalSearchCachePort<T> {
	private readonly cache: LRUCache<string, T>;

	constructor(options: InMemoryExternalSearchCacheOptions = {}) {
		this.cache = new LRUCache<string, T>({
			max: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
			ttl: options.ttlMs ?? DEFAULT_TTL_MS,
		});
	}

	async get(key: ExternalSearchCacheKey): Promise<T | undefined> {
		return this.cache.get(deriveExternalSearchCacheKey(key));
	}

	async set(key: ExternalSearchCacheKey, value: T): Promise<void> {
		this.cache.set(deriveExternalSearchCacheKey(key), value);
	}
}
