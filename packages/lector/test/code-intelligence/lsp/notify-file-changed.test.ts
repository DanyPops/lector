/**
 * Real end-to-end proof of the "notify every matching warm server" half of
 * local file-watch support: a server that dynamically registers interest
 * in workspace/didChangeWatchedFiles must actually receive a notification
 * when a matching file changes, and must NOT receive one for a
 * non-matching path.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LanguageServerDescriptor } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../../src/code-intelligence/lsp/lsp-symbol-index.ts";

const MOCK_SERVER_PATH = fileURLToPath(new URL("../../support/watched-files-lsp-server.ts", import.meta.url));

const WATCHED_FILES_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "mock",
	backendId: "watched-files-mock",
	extensions: [".ts"],
	launch: { kind: "system-binary", command: "bun" },
	args: [MOCK_SERVER_PATH],
	rootMarkers: [],
	commonSeedCandidates: [],
	settleMs: 0,
};

let cwd: string | undefined;
let index: LspSymbolIndex | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (cwd) rmSync(cwd, { recursive: true, force: true });
	cwd = undefined;
});

function receivedLogPath(root: string): string {
	return join(root, ".received-watched-files.json");
}

function readReceived(root: string): unknown[] {
	const path = receivedLogPath(root);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}

async function waitForReceived(root: string, count: number, timeoutMs = 2000): Promise<unknown[]> {
	const started = Date.now();
	for (;;) {
		const received = readReceived(root);
		if (received.length >= count) return received;
		if (Date.now() - started > timeoutMs) return received;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("LspSymbolIndex.notifyFileChanged", () => {
	it("sends workspace/didChangeWatchedFiles to a warm server for a path matching its dynamically registered pattern", async () => {
		cwd = mkdtempSync(join(tmpdir(), "lector-watched-files-"));
		const filePath = join(cwd, "file.ts");
		writeFileSync(filePath, "const x = 1;\n");
		index = new LspSymbolIndex(cwd, WATCHED_FILES_DESCRIPTOR);

		// Warms the server and lets its registerCapability request land before the real assertion.
		await index.documentSymbols(filePath);
		await new Promise((resolve) => setTimeout(resolve, 50));

		index.notifyFileChanged({ path: "file.ts", kind: "modified" });

		const received = await waitForReceived(cwd, 1);
		expect(received).toEqual([{ changes: [{ uri: pathToFileURL(filePath).href, type: 2 }] }]);
	});

	it("maps created/modified/deleted to the correct LSP FileChangeType", async () => {
		cwd = mkdtempSync(join(tmpdir(), "lector-watched-files-"));
		const filePath = join(cwd, "file.ts");
		writeFileSync(filePath, "const x = 1;\n");
		index = new LspSymbolIndex(cwd, WATCHED_FILES_DESCRIPTOR);
		await index.documentSymbols(filePath);
		await new Promise((resolve) => setTimeout(resolve, 50));

		index.notifyFileChanged({ path: "file.ts", kind: "created" });
		index.notifyFileChanged({ path: "file.ts", kind: "modified" });
		index.notifyFileChanged({ path: "file.ts", kind: "deleted" });

		const received = await waitForReceived(cwd, 3);
		expect(received.map((entry) => (entry as { changes: Array<{ type: number }> }).changes[0]?.type)).toEqual([1, 2, 3]);
	});

	it("never notifies for a path that matches no dynamically registered pattern", async () => {
		cwd = mkdtempSync(join(tmpdir(), "lector-watched-files-"));
		const filePath = join(cwd, "file.ts");
		writeFileSync(filePath, "const x = 1;\n");
		index = new LspSymbolIndex(cwd, WATCHED_FILES_DESCRIPTOR);
		await index.documentSymbols(filePath);
		await new Promise((resolve) => setTimeout(resolve, 50));

		index.notifyFileChanged({ path: "README.md", kind: "modified" }); // server only registered **/*.ts
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(readReceived(cwd)).toEqual([]);
	});

	it("is a safe no-op before any server has ever been spawned, and never spawns one just to check", async () => {
		cwd = mkdtempSync(join(tmpdir(), "lector-watched-files-"));
		writeFileSync(join(cwd, "file.ts"), "const x = 1;\n");
		index = new LspSymbolIndex(cwd, WATCHED_FILES_DESCRIPTOR);

		expect(() => index?.notifyFileChanged({ path: "file.ts", kind: "modified" })).not.toThrow();
		expect(index.processId).toBeUndefined(); // still cold -- notifyFileChanged must never spawn
	});
});
