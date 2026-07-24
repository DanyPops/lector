/**
 * The same LspSymbolIndex class, configured for Python via a real pyright
 * process instead of typescript-language-server -- the actual proof this
 * generalizes beyond TypeScript, not just a type-level claim.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../../../src/adapters/lsp/lsp-symbol-index.ts";
import { documentSymbols } from "../../../src/domain/document-symbols.ts";
import { goToDefinition } from "../../../src/domain/go-to-definition.ts";
import { hoverAt } from "../../../src/domain/hover-at.ts";
import { PYTHON_DESCRIPTOR } from "../../../src/domain/language-server-descriptor.ts";
import { findPositionOf } from "../../support/find-position.ts";

let fixtureRoot: string | undefined;
let index: LspSymbolIndex | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): { root: string; mainFile: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-python-fixture-"));
	writeFileSync(
		join(root, "main.py"),
		"def add(a: int, b: int) -> int:\n    return a + b\n\n\ndef add_twice(a: int, b: int) -> int:\n    return add(a, b) + add(a, b)\n",
	);
	return { root, mainFile: join(root, "main.py") };
}

describe("LspSymbolIndex configured for Python", () => {
	it("documentSymbols lists real Python function declarations via a live pyright process", async () => {
		const { root, mainFile } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, PYTHON_DESCRIPTOR, "main.py");

		const symbols = await documentSymbols(index, mainFile);

		expect(symbols.find((symbol) => symbol.name === "add")).toBeDefined();
		expect(symbols.find((symbol) => symbol.name === "add_twice")).toBeDefined();
	}, 20_000);

	it("hover returns a real Python type signature, not an empty result", async () => {
		const { root, mainFile } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, PYTHON_DESCRIPTOR, "main.py");
		const declaration = findPositionOf(mainFile, "def add(");
		const at = { path: mainFile, line: declaration.line, character: declaration.character + "def ".length };

		const hover = await hoverAt(index, at);

		expect(hover).toBeDefined();
		expect(hover?.contents.length).toBeGreaterThan(0);
		expect(hover?.contents).toContain("add");
	}, 20_000);

	it("goToDefinition resolves a real cross-line Python function call to its declaration", async () => {
		const { root, mainFile } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, PYTHON_DESCRIPTOR, "main.py");
		const usage = findPositionOf(mainFile, "return add(a, b) + add(a, b)");
		const at = { path: mainFile, line: usage.line, character: usage.character + "return ".length };

		const locations = await goToDefinition(index, at);

		expect(locations.length).toBeGreaterThan(0);
		expect(locations[0]?.path).toBe(mainFile);
	}, 20_000);
});
