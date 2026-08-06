import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageServerDescriptor } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../../src/code-intelligence/lsp/lsp-symbol-index.ts";

const SERVER_PATH = fileURLToPath(new URL("../../support/show-message-request-lsp-server.ts", import.meta.url));
const DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "typescript",
	backendId: "show-message-request-fixture",
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

describe("LspSymbolIndex window/showMessageRequest policy", () => {
	it("answers null so a headless client cancels rather than selecting an action for the user", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-show-message-request-"));
		const seed = join(root, "seed.ts");
		writeFileSync(seed, "export const value = 1;\n");
		index = new LspSymbolIndex(root, DESCRIPTOR, "seed.ts");

		const symbols = await index.documentSymbols(seed);

		expect(symbols).toEqual([]);
		expect(index.processId).toBeDefined();
	});
});
