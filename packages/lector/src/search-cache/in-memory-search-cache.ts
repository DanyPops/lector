import { LRUCache } from "lru-cache";
import type { TextSearchResult } from "../text-search/text-search-result.ts";
import type { SearchCachePort } from "./port.ts";
import { deriveSearchCacheKey, type SearchCacheKey } from "./search-cache-key.ts";

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface InMemorySearchCacheOptions {
	readonly maxEntries?: number;
	readonly ttlMs?: number;
}

/** SearchCachePort backed by lru-cache -- count- and TTL-bounded, not a hand-rolled Map+timestamp cache. */
export class InMemorySearchCache implements SearchCachePort {
	private readonly cache: LRUCache<string, TextSearchResult>;

	constructor(options: InMemorySearchCacheOptions = {}) {
		this.cache = new LRUCache<string, TextSearchResult>({
			max: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
			ttl: options.ttlMs ?? DEFAULT_TTL_MS,
		});
	}

	async get(key: SearchCacheKey): Promise<TextSearchResult | undefined> {
		return this.cache.get(deriveSearchCacheKey(key));
	}

	async set(key: SearchCacheKey, result: TextSearchResult): Promise<void> {
		this.cache.set(deriveSearchCacheKey(key), result);
	}
}
