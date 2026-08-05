/**
 * Content-Length-framed JSON-RPC message encoding/decoding, per the LSP
 * specification's base protocol. Pure and subprocess-free by design: this
 * module never touches child_process, so it is independently testable
 * against arbitrary byte-chunk boundaries without spawning anything.
 */

export interface JsonRpcMessage {
	readonly jsonrpc: "2.0";
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export class JsonRpcMessageLimitExceeded extends Error {
	constructor(
		readonly limit: "header-bytes" | "message-bytes" | "buffered-bytes",
		readonly maxBytes: number,
		readonly observedBytes: number,
	) {
		super(`JSON-RPC ${limit} exceeded ${maxBytes} bytes (observed ${observedBytes})`);
		this.name = "JsonRpcMessageLimitExceeded";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
	if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
	if (value.id !== undefined && typeof value.id !== "number" && typeof value.id !== "string") return false;
	if (value.method !== undefined && typeof value.method !== "string") return false;
	if (value.error !== undefined) {
		if (!isRecord(value.error) || typeof value.error.code !== "number" || typeof value.error.message !== "string") return false;
	}
	return true;
}

export interface JsonRpcStreamDecoderOptions {
	readonly maxHeaderBytes?: number;
	readonly maxMessageBytes?: number;
}

export function encodeJsonRpcMessage(message: JsonRpcMessage): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf-8");
	const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii");
	return Buffer.concat([header, body]);
}

/**
 * Incrementally parses Content-Length-framed messages from a byte stream
 * that may deliver partial messages, multiple messages per chunk, or a
 * header/body split across chunk boundaries -- exactly what a real child
 * process's stdout does under backpressure or large payloads.
 */
export class JsonRpcStreamDecoder {
	private buffer: Buffer = Buffer.alloc(0);
	private readonly maxHeaderBytes: number;
	private readonly maxMessageBytes: number;

	constructor(options: JsonRpcStreamDecoderOptions = {}) {
		this.maxHeaderBytes = options.maxHeaderBytes ?? 8 * 1024;
		this.maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
		if (!Number.isSafeInteger(this.maxHeaderBytes) || this.maxHeaderBytes < 1) throw new TypeError("maxHeaderBytes must be a positive safe integer");
		if (!Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 1) throw new TypeError("maxMessageBytes must be a positive safe integer");
	}

	/** Feed one chunk; returns every complete message it produced (zero or more, in order). */
	push(chunk: Buffer): JsonRpcMessage[] {
		const bufferedBytes = this.buffer.byteLength + chunk.byteLength;
		const maxBufferedBytes = this.maxHeaderBytes + this.maxMessageBytes;
		if (bufferedBytes > maxBufferedBytes) throw new JsonRpcMessageLimitExceeded("buffered-bytes", maxBufferedBytes, bufferedBytes);
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const messages: JsonRpcMessage[] = [];

		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				if (this.buffer.byteLength > this.maxHeaderBytes) throw new JsonRpcMessageLimitExceeded("header-bytes", this.maxHeaderBytes, this.buffer.byteLength);
				break;
			}
			if (headerEnd > this.maxHeaderBytes) throw new JsonRpcMessageLimitExceeded("header-bytes", this.maxHeaderBytes, headerEnd);

			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			const digits = match?.[1];
			if (digits === undefined) {
				// Malformed header we cannot recover a length from: drop through the
				// terminator and keep going rather than getting stuck on it forever.
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}

			const length = Number.parseInt(digits, 10);
			if (!Number.isSafeInteger(length) || length > this.maxMessageBytes) {
				throw new JsonRpcMessageLimitExceeded("message-bytes", this.maxMessageBytes, length);
			}
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + length;
			if (this.buffer.byteLength < bodyEnd) break; // body split across chunks -- wait for more

			const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
			this.buffer = this.buffer.subarray(bodyEnd);
			try {
				const value: unknown = JSON.parse(body);
				if (isJsonRpcMessage(value)) messages.push(value);
			} catch {
				// An unparseable body must not crash the whole stream -- skip it and continue.
			}
		}

		return messages;
	}
}
