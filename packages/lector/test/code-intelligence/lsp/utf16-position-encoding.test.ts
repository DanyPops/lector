/**
 * Cross-checks Lector's position handling against a real running
 * typescript-language-server, not a re-derivation of Lector's own
 * expectation of where a position should be. Five astral-plane emoji
 * before a one-character identifier make UTF-16 code units, UTF-8 bytes,
 * and Unicode codepoints diverge by enough (10 and 5 units respectively)
 * that a wrong encoding assumption lands well outside that single
 * character, not just elsewhere within a wider, more forgiving token --
 * a test that computed its own "expected" position the same (possibly
 * wrong) way Lector does could never catch a real mismatch, since both
 * sides would agree on the wrong answer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goToDefinition } from "../../../src/code-intelligence/go-to-definition.ts";
import { hoverAt } from "../../../src/code-intelligence/hover-at.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { findPositionOf } from "../../support/find-position.ts";

const COMMENT_PREFIX = "const y = /* \u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600} */ ";

let index: LspSymbolIndex | undefined;
let fixtureRoot: string | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-utf16-position-"));
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	writeFileSync(
		join(root, "target.ts"),
		`export function f(x: number): number {\n\treturn x * 2;\n}\n\n${COMMENT_PREFIX}f(1); // padding so an out-of-range probe still lands on a real character\n`,
	);
	return root;
}

describe("UTF-16 position encoding against a real running language server", () => {
	it("confirms this fixture actually exercises divergent encodings, not an accidentally all-ASCII case", () => {
		// Real numbers, not assumed: five astral-plane emoji make UTF-16 code units, UTF-8
		// bytes, and Unicode codepoints disagree by 10 and 5 units respectively -- comfortably
		// more than the one-character identifier these tests point at.
		expect(COMMENT_PREFIX.length).toBe(27);
		expect(Buffer.byteLength(COMMENT_PREFIX, "utf8")).toBe(37);
		expect([...COMMENT_PREFIX].length).toBe(22);
	});

	it("resolves the one-character identifier correctly at its real UTF-16 code-unit position", async () => {
		fixtureRoot = buildFixture();
		const targetPath = join(fixtureRoot, "target.ts");
		index = new LspSymbolIndex(fixtureRoot, TYPESCRIPT_DESCRIPTOR, "target.ts");

		const usage = findPositionOf(targetPath, "f(1)");
		expect(usage.character - 1).toBe(COMMENT_PREFIX.length); // real ground truth: UTF-16 code units

		const definitions = await goToDefinition(index, { path: targetPath, line: usage.line, character: usage.character });
		expect(index.capabilities?.positionEncoding).toBe("utf-16");
		expect(definitions).toHaveLength(1);
		expect(definitions[0]?.path).toBe(targetPath);
		expect(definitions[0]?.line).toBe(1);

		const hover = await hoverAt(index, { path: targetPath, line: usage.line, character: usage.character });
		expect(hover?.contents).toContain("function f(");
	}, 20_000);

	it("a UTF-8-byte-based (wrong) offset lands on unrelated trailing text, not the identifier", async () => {
		fixtureRoot = buildFixture();
		const targetPath = join(fixtureRoot, "target.ts");
		index = new LspSymbolIndex(fixtureRoot, TYPESCRIPT_DESCRIPTOR, "target.ts");
		const usage = findPositionOf(targetPath, "f(1)");

		const byteOffset = Buffer.byteLength(COMMENT_PREFIX, "utf8"); // 37, 10 units past the real 27
		const hover = await hoverAt(index, { path: targetPath, line: usage.line, character: byteOffset + 1 });

		expect(hover?.contents ?? "").not.toContain("function f(");
	}, 20_000);

	it("a Unicode-codepoint-based (wrong) offset lands inside the comment, not the identifier", async () => {
		fixtureRoot = buildFixture();
		const targetPath = join(fixtureRoot, "target.ts");
		index = new LspSymbolIndex(fixtureRoot, TYPESCRIPT_DESCRIPTOR, "target.ts");
		const usage = findPositionOf(targetPath, "f(1)");

		const codepointOffset = [...COMMENT_PREFIX].length; // 22, 5 units short of the real 27
		const hover = await hoverAt(index, { path: targetPath, line: usage.line, character: codepointOffset + 1 });

		expect(hover?.contents ?? "").not.toContain("function f(");
	}, 20_000);
});
