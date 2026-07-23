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

	/** Feed one chunk; returns every complete message it produced (zero or more, in order). */
	push(chunk: Buffer): JsonRpcMessage[] {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const messages: JsonRpcMessage[] = [];

		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break; // header itself split across chunks -- wait for more

			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				// Malformed header we cannot recover a length from: drop through the
				// terminator and keep going rather than getting stuck on it forever.
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}

			const length = Number.parseInt(match[1]!, 10);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + length;
			if (this.buffer.byteLength < bodyEnd) break; // body split across chunks -- wait for more

			const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
			this.buffer = this.buffer.subarray(bodyEnd);
			try {
				messages.push(JSON.parse(body) as JsonRpcMessage);
			} catch {
				// An unparseable body must not crash the whole stream -- skip it and continue.
			}
		}

		return messages;
	}
}
