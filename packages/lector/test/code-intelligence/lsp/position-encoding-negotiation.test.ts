import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageServerDescriptor } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { LanguageServerPositionEncodingUnsupported, LspSymbolIndex } from "../../../src/code-intelligence/lsp/lsp-symbol-index.ts";

const SERVER_PATH = fileURLToPath(new URL("../../support/position-encoding-lsp-server.ts", import.meta.url));
const DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "typescript",
	backendId: "position-encoding-fixture",
	extensions: [".ts"],
	launch: { kind: "system-binary", command: process.execPath },
	args: [SERVER_PATH],
	rootMarkers: [],
	commonSeedCandidates: ["seed.ts"],
	settleMs: 0,
};

let root: string | undefined;
let index: LspSymbolIndex | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("LspSymbolIndex position-encoding negotiation", () => {
	it("advertises only the UTF-16 position model Lector actually supports and records the server selection", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-position-encoding-"));
		const seed = join(root, "seed.ts");
		writeFileSync(seed, "export const value = 1;\n");
		index = new LspSymbolIndex(root, DESCRIPTOR, "seed.ts");

		await index.documentSymbols(seed);

		const initializeParams = JSON.parse(readFileSync(join(root, ".initialize-params.json"), "utf-8")) as {
			capabilities?: { general?: { positionEncodings?: unknown } };
		};
		expect(initializeParams.capabilities?.general?.positionEncodings).toEqual(["utf-16"]);
		expect(index.capabilities?.positionEncoding).toBe("utf-16");
	});

	it("fails closed when a server selects an encoding the client did not advertise", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-position-encoding-"));
		const seed = join(root, "seed.ts");
		writeFileSync(seed, "export const value = 1;\n");
		index = new LspSymbolIndex(root, { ...DESCRIPTOR, args: [SERVER_PATH, "--utf8"] }, "seed.ts");

		let failure: unknown;
		try {
			await index.documentSymbols(seed);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(LanguageServerPositionEncodingUnsupported);
	});
});
