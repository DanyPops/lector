/**
 * bash-language-server@5.6.0 hard-pins editorconfig@2.0.1, whose own
 * minimatch@10.0.1/brace-expansion@2.1.2 dependency carries four real ReDoS/OOM
 * advisories (GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74,
 * GHSA-mh99-v99m-4gvg). bash-language-server only calls editorconfig.parse()
 * from its shfmt formatter, reached exclusively via textDocument/formatting --
 * a request Lector never sends. This proves that directly: a workspace
 * containing the single most severe published trigger (a 12-byte nested
 * extglob pattern that stalls a bare minimatch() call for 60-120+ seconds)
 * as a real .editorconfig section header does not slow down any Bash
 * operation Lector actually performs.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentSymbols } from "../../../src/code-intelligence/document-symbols.ts";
import { goToDefinition } from "../../../src/code-intelligence/go-to-definition.ts";
import { BASH_DESCRIPTOR } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { findWorkspaceSymbols } from "../../../src/workspace/find-workspace-symbols.ts";
import { findPositionOf } from "../../support/find-position.ts";

/** The most severe published minimatch extglob-nesting trigger (GHSA-23c5-xmqv-rm74): ~7s+ for a single non-matching minimatch() call, growing to minutes with one more nesting level. */
const MALICIOUS_EDITORCONFIG = "root = true\n\n[*(*(*(*(a|b))))]\nindent_style = space\n";

/** Generous relative to the advisory's own measured 7-124+ second hangs, tight relative to a real bounded LSP round trip (typically well under 2s). */
const SAFETY_TIMEOUT_MS = 10_000;

let fixtureRoot: string | undefined;
let index: LspSymbolIndex | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildAdversarialFixture(): { root: string; mainFile: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-bash-adversarial-"));
	writeFileSync(join(root, ".editorconfig"), MALICIOUS_EDITORCONFIG);
	const mainFile = join(root, "main.sh");
	writeFileSync(mainFile, "add() {\n    echo $(( $1 + $2 ))\n}\n\nadd_twice() {\n    add 1 2\n    add 1 2\n}\n");
	return { root, mainFile };
}

describe("Bash operations against a workspace with a malicious .editorconfig", () => {
	it(
		"documentSymbols completes quickly -- editorconfig.parse() is never reached without textDocument/formatting",
		async () => {
			const fixture = buildAdversarialFixture();
			fixtureRoot = fixture.root;
			index = new LspSymbolIndex(fixture.root, BASH_DESCRIPTOR, "main.sh");

			const started = Date.now();
			const symbols = await documentSymbols(index, fixture.mainFile);
			const elapsedMs = Date.now() - started;

			expect(symbols.find((symbol) => symbol.name === "add")).toBeDefined();
			expect(symbols.find((symbol) => symbol.name === "add_twice")).toBeDefined();
			expect(elapsedMs).toBeLessThan(SAFETY_TIMEOUT_MS);
		},
		SAFETY_TIMEOUT_MS + 20_000,
	);

	it(
		"findWorkspaceSymbols completes quickly against the same adversarial workspace",
		async () => {
			const fixture = buildAdversarialFixture();
			fixtureRoot = fixture.root;
			index = new LspSymbolIndex(fixture.root, BASH_DESCRIPTOR, "main.sh");

			const started = Date.now();
			const result = await findWorkspaceSymbols(index, "add");
			const elapsedMs = Date.now() - started;

			expect(result.symbols.find((symbol) => symbol.name === "add")).toBeDefined();
			expect(elapsedMs).toBeLessThan(SAFETY_TIMEOUT_MS);
		},
		SAFETY_TIMEOUT_MS + 20_000,
	);

	it(
		"goToDefinition completes quickly against the same adversarial workspace",
		async () => {
			const fixture = buildAdversarialFixture();
			fixtureRoot = fixture.root;
			index = new LspSymbolIndex(fixture.root, BASH_DESCRIPTOR, "main.sh");
			const usage = findPositionOf(fixture.mainFile, "    add 1 2");
			const at = { path: fixture.mainFile, line: usage.line, character: usage.character + 4 };

			const started = Date.now();
			const locations = await goToDefinition(index, at);
			const elapsedMs = Date.now() - started;

			expect(locations.length).toBeGreaterThan(0);
			expect(elapsedMs).toBeLessThan(SAFETY_TIMEOUT_MS);
		},
		SAFETY_TIMEOUT_MS + 20_000,
	);
});
