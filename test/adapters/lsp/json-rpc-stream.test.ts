import { describe, expect, it } from "bun:test";
import { encodeJsonRpcMessage, JsonRpcStreamDecoder } from "../../../src/adapters/lsp/json-rpc-stream.ts";

describe("encodeJsonRpcMessage / JsonRpcStreamDecoder", () => {
	it("round-trips a single message fed as one chunk", () => {
		const decoder = new JsonRpcStreamDecoder();
		const encoded = encodeJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { foo: "bar" } });

		const messages = decoder.push(encoded);

		expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { foo: "bar" } }]);
	});

	it("decodes multiple messages delivered in a single chunk", () => {
		const decoder = new JsonRpcStreamDecoder();
		const encoded = Buffer.concat([
			encodeJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "a" }),
			encodeJsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "b" }),
		]);

		const messages = decoder.push(encoded);

		expect(messages.map((m) => m.id)).toEqual([1, 2]);
	});

	it("decodes a message whose header is split across chunk boundaries", () => {
		const decoder = new JsonRpcStreamDecoder();
		const encoded = encodeJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
		const splitPoint = 8; // lands inside "Content-Length: NN" itself

		expect(decoder.push(encoded.subarray(0, splitPoint))).toEqual([]);
		expect(decoder.push(encoded.subarray(splitPoint))).toEqual([{ jsonrpc: "2.0", id: 1, method: "initialize" }]);
	});

	it("decodes a message whose body is split across chunk boundaries", () => {
		const decoder = new JsonRpcStreamDecoder();
		const encoded = encodeJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1, b: 2, c: 3 } });
		const headerEnd = encoded.indexOf("\r\n\r\n") + 4;
		const splitPoint = headerEnd + 5; // lands mid-body

		expect(decoder.push(encoded.subarray(0, splitPoint))).toEqual([]);
		expect(decoder.push(encoded.subarray(splitPoint))).toEqual([
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1, b: 2, c: 3 } },
		]);
	});

	it("recovers after a malformed header instead of getting stuck forever", () => {
		const decoder = new JsonRpcStreamDecoder();
		const malformed = Buffer.from("Not-A-Real-Header: nope\r\n\r\n", "ascii");
		const valid = encodeJsonRpcMessage({ jsonrpc: "2.0", id: 7, method: "ok" });

		const messages = decoder.push(Buffer.concat([malformed, valid]));

		expect(messages).toEqual([{ jsonrpc: "2.0", id: 7, method: "ok" }]);
	});

	it("skips an unparseable body without crashing the stream", () => {
		const decoder = new JsonRpcStreamDecoder();
		const brokenBody = Buffer.from("not valid json", "utf-8");
		const broken = Buffer.concat([Buffer.from(`Content-Length: ${brokenBody.byteLength}\r\n\r\n`, "ascii"), brokenBody]);
		const valid = encodeJsonRpcMessage({ jsonrpc: "2.0", id: 9, method: "ok" });

		const messages = decoder.push(Buffer.concat([broken, valid]));

		expect(messages).toEqual([{ jsonrpc: "2.0", id: 9, method: "ok" }]);
	});
});
