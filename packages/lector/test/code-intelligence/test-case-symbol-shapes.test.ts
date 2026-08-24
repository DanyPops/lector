/**
 * Locks in the real, verified extent of per-test-case symbol identity today
 * (see the "Test-anchored dataflow narratives" research doc). A flat,
 * non-recursive document-symbols view makes a describe/it suite look like
 * one collapsed node -- but typescript-language-server's real hierarchy
 * already gives each plain it() case its own descriptively-named position.
 * The real, narrower gap is parameterized/table-driven forms: test.each's
 * curried call loses its synthesized name (TypeScript), gopls never
 * descends into t.Run's closure at all (Go), and pyright has no per-case
 * position to find at all for @pytest.mark.parametrize (Python) -- there is
 * no syntax to point at, only runtime data. Any future test-case symbol
 * extractor changes this on purpose; when it does, these are the
 * assertions to update.
 *
 * Go/Python fixtures are generated at runtime (mkdtempSync), not committed
 * under test/fixtures/ -- committing them there once caused a real
 * regression: discoverWorkspaceDescriptors scans up to 4 directories deep
 * under "Lector's own source" for every registered language's extensions,
 * so a committed .go/.py file anywhere under packages/lector/test turned
 * unrelated whole-repo dogfood tests into unwanted polyglot workspaces.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentSymbols } from "../../src/code-intelligence/document-symbols.ts";
import { GO_DESCRIPTOR, PYTHON_DESCRIPTOR, TYPESCRIPT_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { TreeSitterSymbolIndex } from "../../src/code-intelligence/tree-sitter/tree-sitter-symbol-index.ts";

const LECTOR_ROOT = new URL("../..", import.meta.url).pathname;
const TS_FIXTURE_DIR = join(LECTOR_ROOT, "test/fixtures/test-case-shapes/typescript");
const TS_TEST_FILE = join(TS_FIXTURE_DIR, "withdraw.test.ts");

describe("test-case symbol shapes: describe/it/test.each (TreeSitterSymbolIndex)", () => {
	it("finds the real named declarations in the implementation file", async () => {
		const index = new TreeSitterSymbolIndex(TS_FIXTURE_DIR);
		const results = await index.findSymbols("");

		expect(results.symbols.map((symbol) => symbol.name)).toContain("withdraw");
		expect(results.symbols.map((symbol) => symbol.name)).toContain("Account");
	});

	it("finds zero symbols in the test file -- describe/it/test.each are call expressions, not declarations tree-sitter's DECLARATION_KINDS table recognizes", async () => {
		const index = new TreeSitterSymbolIndex(TS_FIXTURE_DIR);
		const results = await index.findSymbols("");

		const fromTestFile = results.symbols.filter((symbol) => symbol.location.path.endsWith("withdraw.test.ts"));
		expect(fromTestFile).toEqual([]);
	});
});

describe("test-case symbol shapes: describe/it/test.each (LspSymbolIndex, typescript-language-server)", () => {
	it("gives each plain it() case its own descriptively-named nested symbol -- not collapsed into the describe block", async () => {
		const index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "test/fixtures/test-case-shapes/typescript/withdraw.test.ts");
		try {
			const entries = await documentSymbols(index, TS_TEST_FILE);

			// One top-level entry for the describe block itself...
			expect(entries).toHaveLength(1);
			const [suite] = entries;
			expect(suite?.kind).toBe("function");
			expect(suite?.name).toBe('describe("withdraw") callback');

			// ...but typescript-language-server's navtree does recurse into it: each plain it()
			// case is its own child, with a real, distinct, descriptively-named position -- not
			// invisible, contrary to what a flat (non-recursive) document-symbols view suggests.
			const childNames = (suite?.children ?? []).map((child) => child.name);
			expect(childNames).toContain('it("rejects a withdrawal larger than the balance") callback');
			expect(childNames).toContain('it("debits the account by exactly the requested amount") callback');
		} finally {
			await index.close();
		}
	});

	it("loses the descriptive name for test.each()'s curried callback -- a real, narrower gap than plain it()", async () => {
		const index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "test/fixtures/test-case-shapes/typescript/withdraw.test.ts");
		try {
			const entries = await documentSymbols(index, TS_TEST_FILE);
			const [suite] = entries;
			const childNames = (suite?.children ?? []).map((child) => child.name);

			// test.each(table)("name template", fn) is a curried call -- tsserver's navtree
			// heuristic only recognizes the direct fn(stringLiteral, functionExpr) shape, so
			// this callback still gets its own node (a real, distinct position exists), but
			// with no name synthesized from its format-string argument at all.
			expect(childNames).toContain("<function>");
			expect(childNames.some((name) => name.includes("non-positive withdrawal amount"))).toBe(false);
		} finally {
			await index.close();
		}
	});
});

/** Distilled from real-world pytest idioms (simonw/sqlite-utils, LeiLiLab/susvibes). */
function buildPytestParametrizeFixture(): { root: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-test-case-shapes-python-"));
	writeFileSync(
		join(root, "withdraw.py"),
		"def withdraw(balance: int, amount: int) -> int:\n    if amount <= 0:\n        raise ValueError('invalid amount')\n    if amount > balance:\n        raise ValueError('insufficient funds')\n    return balance - amount\n",
	);
	writeFileSync(
		join(root, "test_withdraw.py"),
		[
			"import pytest",
			"",
			"from withdraw import withdraw",
			"",
			"",
			"@pytest.mark.parametrize(",
			'    "balance,amount,should_raise",',
			"    [(10, 20, True), (10, 4, False), (10, 0, True)],",
			")",
			"def test_withdraw_cases(balance, amount, should_raise):",
			"    if should_raise:",
			"        with pytest.raises(ValueError):",
			"            withdraw(balance, amount)",
			"    else:",
			"        assert withdraw(balance, amount) == balance - amount",
			"",
		].join("\n"),
	);
	return { root };
}

describe("test-case symbol shapes: @pytest.mark.parametrize (LspSymbolIndex, pyright)", () => {
	it("has no per-case position at all -- parametrize multiplies one real function at runtime, with no closure or syntax for pyright to point at", async () => {
		const { root } = buildPytestParametrizeFixture();
		const index = new LspSymbolIndex(root, PYTHON_DESCRIPTOR, "test_withdraw.py");
		try {
			const entries = await documentSymbols(index, join(root, "test_withdraw.py"));

			// One named function, decorated but not multiplied -- there is no third case's own
			// position to find, in principle, without actually running the parametrized test.
			// pyright's children here are just the function's own parameters ("balance",
			// "amount", "should_raise"), not one entry per parametrize row.
			expect(entries.map((entry) => entry.name)).toEqual(["test_withdraw_cases"]);
			expect((entries[0]?.children ?? []).every((child) => child.kind === "variable")).toBe(true);
		} finally {
			await index.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

/** Distilled from real-world table-driven Go tests (edoardottt/csprecon's TestPrepareURL). */
function buildGoTableDrivenFixture(): { root: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-test-case-shapes-go-"));
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "go.mod"), "module account\n\ngo 1.22\n");
	writeFileSync(
		join(root, "withdraw.go"),
		[
			"package account",
			"",
			'import "errors"',
			"",
			"func Withdraw(balance int, amount int) (int, error) {",
			"\tif amount <= 0 {",
			'\t\treturn balance, errors.New("invalid amount")',
			"\t}",
			"\tif amount > balance {",
			'\t\treturn balance, errors.New("insufficient funds")',
			"\t}",
			"\treturn balance - amount, nil",
			"}",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(root, "withdraw_test.go"),
		[
			"package account",
			"",
			'import "testing"',
			"",
			"func TestWithdraw(t *testing.T) {",
			"\ttests := []struct {",
			"\t\tname    string",
			"\t\tbalance int",
			"\t\tamount  int",
			"\t\twantErr bool",
			"\t}{",
			'\t\t{name: "rejects amount larger than balance", balance: 10, amount: 20, wantErr: true},',
			'\t\t{name: "debits exactly the requested amount", balance: 10, amount: 4, wantErr: false},',
			"\t}",
			"\tfor _, tt := range tests {",
			"\t\tt.Run(tt.name, func(t *testing.T) {",
			"\t\t\t_, err := Withdraw(tt.balance, tt.amount)",
			"\t\t\tif (err != nil) != tt.wantErr {",
			'\t\t\t\tt.Fatalf("Withdraw(%d, %d) error = %v, wantErr %v", tt.balance, tt.amount, err, tt.wantErr)',
			"\t\t\t}",
			"\t\t})",
			"\t}",
			"}",
			"",
		].join("\n"),
	);
	return { root };
}

describe("test-case symbol shapes: table-driven t.Run subtests (LspSymbolIndex, gopls)", () => {
	it("never descends into t.Run's closure at all -- TestWithdraw is the only symbol gopls reports for the whole file", async () => {
		const { root } = buildGoTableDrivenFixture();
		const index = new LspSymbolIndex(root, GO_DESCRIPTOR, "withdraw_test.go");
		try {
			const entries = await documentSymbols(index, join(root, "withdraw_test.go"));

			// Unlike tsserver's navtree, gopls' documentSymbol only reports real top-level
			// declarations -- the anonymous func literal passed to t.Run for each table row
			// never becomes its own symbol, nested or otherwise. Every subtest case is
			// invisible; TestWithdraw is the sole seedable position.
			expect(entries.map((entry) => entry.name)).toEqual(["TestWithdraw"]);
			expect(entries[0]?.children ?? []).toEqual([]);
		} finally {
			await index.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
