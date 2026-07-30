/**
 * Shared bounded, streaming JSON body reading -- the same "check Content-Length up front, then
 * check cumulative bytes read as chunks arrive (a header can be absent or lie)" shape every
 * bounded HTTP adapter in this project needs (npm registry, GitHub search). Each adapter wraps
 * the two generic errors here into its own typed error at the call site, preserving its own
 * public error contract.
 */

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class BoundedResponseTooLarge extends Error {
	constructor(
		readonly limit: number,
		readonly observed: number,
	) {
		super(`response exceeded ${limit} bytes (observed ${observed})`);
		this.name = "BoundedResponseTooLarge";
	}
}

export class MalformedBoundedResponse extends Error {
	constructor() {
		super("response body was not valid JSON, or the stream ended without a usable body");
		this.name = "MalformedBoundedResponse";
	}
}

export async function discardResponseBody(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

/**
 * Reads a Response's body bounded by `limit` bytes, parses it as JSON. `budget` lets two
 * sequential requests within one logical operation (e.g. npm's package-then-version lookup)
 * share one cumulative limit -- defaults to a fresh, per-call budget.
 */
export async function readBoundedJson(response: Response, limit: number, budget: { used: number } = { used: 0 }): Promise<unknown> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > limit - budget.used) {
		await discardResponseBody(response);
		throw new BoundedResponseTooLarge(limit, budget.used + declaredLength);
	}
	const chunks: Buffer[] = [];
	const body: ReadableStream<Uint8Array> | null = response.body;
	if (body === null) throw new MalformedBoundedResponse();
	const reader = body.getReader();
	let finished = false;
	while (!finished) {
		const read: unknown = await reader.read();
		if (!isJsonRecord(read) || typeof read.done !== "boolean") throw new MalformedBoundedResponse();
		if (read.done) {
			finished = true;
			continue;
		}
		if (!(read.value instanceof Uint8Array)) throw new MalformedBoundedResponse();
		budget.used += read.value.byteLength;
		if (budget.used > limit) {
			await reader.cancel();
			throw new BoundedResponseTooLarge(limit, budget.used);
		}
		chunks.push(Buffer.from(read.value));
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new MalformedBoundedResponse();
	}
}
