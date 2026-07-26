export const MAX_SYMBOL_QUERY_BYTES = 4_096;

export class InvalidSymbolQuery extends Error {
	constructor(
		readonly maxBytes: number,
		readonly observedBytes: number,
	) {
		super(`symbol query exceeds ${maxBytes} UTF-8 bytes (observed ${observedBytes})`);
		this.name = "InvalidSymbolQuery";
	}
}

export function assertBoundedSymbolQuery(query: string): void {
	const observedBytes = Buffer.byteLength(query, "utf-8");
	if (observedBytes > MAX_SYMBOL_QUERY_BYTES) throw new InvalidSymbolQuery(MAX_SYMBOL_QUERY_BYTES, observedBytes);
}
