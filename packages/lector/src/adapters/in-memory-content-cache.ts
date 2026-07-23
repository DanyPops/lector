import type { ContentHash } from "../domain/content-hash.ts";
import type { ContentCacheEntry, ContentCachePort, ContentSymbol } from "../ports/content-cache-port.ts";

/** In-process ContentCachePort -- no persistence, cleared on process exit. The default when no durable cache is configured. */
export class InMemoryContentCache implements ContentCachePort {
	private readonly entries = new Map<ContentHash, ContentCacheEntry>();

	async get(hash: ContentHash): Promise<ContentCacheEntry | undefined> {
		return this.entries.get(hash);
	}

	async putRawContent(hash: ContentHash, content: string): Promise<void> {
		this.entries.set(hash, { ...this.entries.get(hash), rawContent: content });
	}

	async putSymbols(hash: ContentHash, symbols: readonly ContentSymbol[]): Promise<void> {
		this.entries.set(hash, { ...this.entries.get(hash), symbols });
	}
}
