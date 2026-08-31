/**
 * Real end-to-end proof of pull-model diagnostics merged with push, against a
 * mock server that declares capabilities.diagnosticProvider -- TypeScript
 * (Lector's push-only reference server) cannot exercise this path at all.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageServerDescriptor } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../../src/code-intelligence/lsp/lsp-symbol-index.ts";

const MOCK_SERVER_PATH = fileURLToPath(new URL("../../support/pull-diagnostics-lsp-server.ts", import.meta.url));

const PULL_DIAGNOSTICS_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "mock",
	backendId: "pull-diagnostics-mock",
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

describe("LspSymbolIndex against a server that declares pull-model diagnostics", () => {
	it("requests textDocument/diagnostic and merges the result with push, deduplicating the shared issue", async () => {
		cwd = mkdtempSync(join(tmpdir(), "lector-pull-diagnostics-"));
		const filePath = join(cwd, "file.ts");
		writeFileSync(filePath, "const x = 1;\n");
		index = new LspSymbolIndex(cwd, PULL_DIAGNOSTICS_DESCRIPTOR);

		// First call: opens the file (triggering the mock's delayed push) and pulls immediately --
		// pull wins the race, push has not landed yet. Proves pull works standalone, independent of
		// push timing.
		const beforePush = await index.diagnostics(filePath);
		expect(beforePush.map((item) => item.message).sort()).toEqual(["pulled: real type error", "same issue, both channels"]);

		// Let the mock's push actually land, then pull again (file content unchanged, so this is a
		// fresh pull merged against now-cached push) -- proves the merge/dedup path for real.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const afterPush = await index.diagnostics(filePath);
		const messages = afterPush.map((item) => item.message).sort();

		// "pulled: real type error" and "pushed: unused variable" are each real to their own
		// channel; "same issue, both channels" is reported by both and must appear exactly once.
		expect(messages).toEqual(["pulled: real type error", "pushed: unused variable", "same issue, both channels"]);
		expect(afterPush.filter((item) => item.message === "same issue, both channels")).toHaveLength(1);
	});

	it("exposes the negotiated diagnosticProvider capability after initialize", async () => {
		cwd = mkdtempSync(join(tmpdir(), "lector-pull-diagnostics-"));
		const filePath = join(cwd, "file.ts");
		writeFileSync(filePath, "const x = 1;\n");
		index = new LspSymbolIndex(cwd, PULL_DIAGNOSTICS_DESCRIPTOR);

		await index.diagnostics(filePath);

		expect(index.capabilities?.diagnosticProvider).toEqual({ interFileDependencies: false, workspaceDiagnostics: true, identifier: undefined });
	});

	it("prefers a bounded workspace/diagnostic pull when the server advertises it", async () => {
		cwd = mkdtempSync(join(tmpdir(), "lector-workspace-diagnostics-"));
		const first = join(cwd, "first.ts");
		const second = join(cwd, "second.ts");
		writeFileSync(first, "const first = 1;\n");
		writeFileSync(second, "const second = 2;\n");
		index = new LspSymbolIndex(cwd, PULL_DIAGNOSTICS_DESCRIPTOR);
		await index.documentSymbols(first);
		await index.documentSymbols(second);

		const diagnostics = await index.workspaceDiagnostics(2, 1, 5_000);
		expect(diagnostics.map(({ range }) => range.path).sort()).toEqual([first, second].sort());
		expect(diagnostics.every(({ code }) => code === "WS0001")).toBe(true);
	});
});
