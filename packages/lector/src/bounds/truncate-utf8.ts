export interface BoundedUtf8 {
	readonly value: string;
	readonly bytes: number;
	readonly truncated: boolean;
}

/** Truncates only at a UTF-8 code-point boundary, so the returned value never exceeds maxBytes or contains a replacement character caused by slicing. */
export function truncateUtf8(value: string, maxBytes: number): BoundedUtf8 {
	const encoded = Buffer.from(value, "utf8");
	if (encoded.byteLength <= maxBytes) return { value, bytes: encoded.byteLength, truncated: false };
	let end = Math.max(0, Math.min(maxBytes, encoded.byteLength));
	while (end > 0) {
		const next = encoded[end];
		if (next === undefined || (next & 0xc0) !== 0x80) break;
		end -= 1;
	}
	const bounded = encoded.subarray(0, end).toString("utf8");
	return { value: bounded, bytes: end, truncated: true };
}
