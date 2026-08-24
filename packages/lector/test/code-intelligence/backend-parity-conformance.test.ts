/**
 * A shared conformance fixture runs the same symbol query against every
 * available backend for a capability (here: LSP-backed
 * LspSymbolIndex vs. tree-sitter-backed TreeSitterSymbolIndex),
 * asserting either identical results or an explicitly documented, tested
 * divergence -- never an untested assumption that "they should agree."
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { TreeSitterSymbolIndex } from "../../src/code-intelligence/tree-sitter/tree-sitter-symbol-index.ts";

let fixtureRoot: string | undefined;
let lspIndex: LspSymbolIndex | undefined;

afterEach(async () => {
	await lspIndex?.close();
	lspIndex = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-parity-fixture-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "math.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	writeFileSync(join(root, "src", "index.ts"), 'export { add } from "./math.ts";\n');
	writeFileSync(
		join(root, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
	);
	return root;
}

describe("backend parity: LSP vs. tree-sitter symbol queries", () => {
	it("agree on name, kind, file, and line when the LSP is warmed against the file containing the actual declaration", async () => {
		fixtureRoot = buildFixture();
		lspIndex = new LspSymbolIndex(fixtureRoot, TYPESCRIPT_DESCRIPTOR, "src/math.ts");
		const treeSitterIndex = new TreeSitterSymbolIndex(fixtureRoot);

		const [lspResults, treeSitterResults] = await Promise.all([lspIndex.findSymbols("add"), treeSitterIndex.findSymbols("add")]);

		const lspMatch = lspResults.symbols.find((symbol) => symbol.name === "add");
		const treeSitterMatch = treeSitterResults.symbols.find((symbol) => symbol.name === "add");

		expect(lspMatch).toBeDefined();
		expect(treeSitterMatch).toBeDefined();
		expect(lspMatch?.kind).toBe("function");
		expect(treeSitterMatch?.kind).toBe("function");
		expect(lspMatch?.location.path).toContain("math.ts");
		expect(treeSitterMatch?.location.path).toContain("math.ts");
		expect(lspMatch?.location.line).toBe(treeSitterMatch?.location.line);
	}, 20_000);

	it("diverge, explainably, when the LSP is only warmed against a barrel re-exporting the symbol", async () => {
		fixtureRoot = buildFixture();
		// Only src/index.ts (the re-exporting barrel) is opened -- tsserver's project then
		// contains the barrel but has no independent reason to have parsed math.ts's own
		// declaration site the way navto reports it (see LspSymbolIndex's own "No
		// Project." doc comment on this class of tsserver quirk).
		lspIndex = new LspSymbolIndex(fixtureRoot, TYPESCRIPT_DESCRIPTOR, "src/index.ts");
		const treeSitterIndex = new TreeSitterSymbolIndex(fixtureRoot);

		const [lspResults, treeSitterResults] = await Promise.all([lspIndex.findSymbols("add"), treeSitterIndex.findSymbols("add")]);

		const lspMatch = lspResults.symbols.find((symbol) => symbol.name === "add");
		const treeSitterMatch = treeSitterResults.symbols.find((symbol) => symbol.name === "add");

		// Both still agree the symbol *exists* under that name -- this is not a case where
		// one backend silently found nothing.
		expect(lspMatch).toBeDefined();
		expect(treeSitterMatch).toBeDefined();

		// tree-sitter always reports the true declaration site. The LSP reports whatever
		// tsserver's navto indexed given only the barrel was opened -- the re-export binding
		// or math.ts's own declaration, depending on tsserver's background loading progress
		// at settle time; genuinely scheduling-dependent, not a fixed one-or-the-other.
		expect(treeSitterMatch?.kind).toBe("function");
		expect(treeSitterMatch?.location.path).toContain("math.ts");
		expect(lspMatch?.location.path).toMatch(/index\.ts|math\.ts/);
	}, 20_000);
});
