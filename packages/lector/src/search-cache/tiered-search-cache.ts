import type { TextSearchResult } from "../domain/text-search-result.ts";
import type { SearchCachePort } from "./port.ts";
import type { SearchCacheKey } from "./search-cache-key.ts";

/**
 * Composes a fast (in-memory) and a durable (disk-backed) SearchCachePort into one: a read
 * checks fast first, falls through to durable on a miss and warms fast with what it finds; a
 * write goes to both. This is what actually delivers the "in-memory tier plus a disk-backed
 * tier" design -- a single SearchCachePort implementation can only be one or the other.
 */
export class TieredSearchCache implements SearchCachePort {
	constructor(
		private readonly fast: SearchCachePort,
		private readonly durable: SearchCachePort,
	) {}

	async get(key: SearchCacheKey): Promise<TextSearchResult | undefined> {
		const fastHit = await this.fast.get(key);
		if (fastHit) return fastHit;

		const durableHit = await this.durable.get(key);
		if (durableHit) await this.fast.set(key, durableHit);
		return durableHit;
	}

	async set(key: SearchCacheKey, result: TextSearchResult): Promise<void> {
		await Promise.all([this.fast.set(key, result), this.durable.set(key, result)]);
	}
}
