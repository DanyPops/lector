/**
 * RCA reproduction for the flaky "waits for real pushed diagnostics after each edit" test
 * (service-code-intelligence.test.ts): typescript-language-server publishes a file's
 * diagnostics in separate kinds (Syntax, Semantic, Suggestion), each independently debounced
 * 50ms, so one edit can legitimately produce two or more distinct publishDiagnostics
 * notifications for the same uri -- an early, incomplete one followed by a later, fuller one.
 * Confirmed directly against typescript-language-server's own DiagnosticsManager/
 * FileDiagnostics source (updateDiagnostics/firePublishDiagnostics/pDebounce(..., 50)).
 *
 * diagnostics() resolves as soon as the FIRST post-edit notification lands and immediately
 * reads whatever is cached at that instant. Under a fast/idle run, both kinds usually land
 * within the same debounce window and get coalesced into one notification; under real CPU
 * contention (a full multi-package CI run spawning many language servers at once) the gap
 * between kinds is more likely to exceed the debounce window, exposing the race -- exactly
 * why this reproduces reliably in a full suite run but not in isolation.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageServerDescriptor } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../../src/code-intelligence/lsp/lsp-symbol-index.ts";

const MOCK_SERVER_PATH = fileURLToPath(new URL("../../support/staggered-diagnostics-lsp-server.ts", import.meta.url));

const STAGGERED_DIAGNOSTICS_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "mock",
	backendId: "staggered-diagnostics-mock",
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

describe("LspSymbolIndex against a server that publishes an edit's diagnostics in two staggered notifications", () => {
	it("desired: waits past an early, incomplete post-edit notification for the fuller one that follows, instead of returning the stale first push", async () => {
		cwd = mkdtempSync(join(tmpdir(), "lector-staggered-diagnostics-"));
		const filePath = join(cwd, "file.ts");
		writeFileSync(filePath, "const x = 1;\n");
		index = new LspSymbolIndex(cwd, STAGGERED_DIAGNOSTICS_DESCRIPTOR);

		const clean = await index.diagnostics(filePath);
		expect(clean).toEqual([]);

		writeFileSync(filePath, "const x: number = 'not a number';\n");
		const afterEdit = await index.diagnostics(filePath);

		expect(afterEdit.some((diagnostic) => diagnostic.message.includes("not assignable"))).toBe(true);
	}, 20_000);
});
