/**
 * A polyglot repo (multiple language subprojects under one parent root --
 * the shape of Oculus's own Rust-root-plus-TypeScript-subdir tests): each
 * language's LspSymbolIndex must resolve and query independently, with no
 * cross-language contamination and combined resource usage within budget.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../../../src/adapters/lsp/lsp-symbol-index.ts";
import { measureProcessTreeRssKb } from "../../../src/adapters/lsp/process-resource-usage.ts";
import { documentSymbols } from "../../../src/domain/document-symbols.ts";
import { descriptorForExtension, GO_DESCRIPTOR, PYTHON_DESCRIPTOR, TYPESCRIPT_DESCRIPTOR } from "../../../src/domain/language-server-descriptor.ts";

function buildPolyglotRepo(): { root: string; goFile: string; pythonFile: string; tsFile: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-polyglot-fixture-"));

	const goRoot = join(root, "backend-go");
	mkdirSync(goRoot);
	writeFileSync(join(goRoot, "go.mod"), "module backend\n\ngo 1.22\n");
	const goFile = join(goRoot, "main.go");
	writeFileSync(goFile, "package main\n\nfunc goOnly(a int, b int) int {\n\treturn a + b\n}\n");

	const pythonRoot = join(root, "scripts-python");
	mkdirSync(pythonRoot);
	const pythonFile = join(pythonRoot, "main.py");
	writeFileSync(pythonFile, "def python_only(a: int, b: int) -> int:\n    return a + b\n");
	writeFileSync(join(pythonRoot, "pyproject.toml"), '[project]\nname = "scripts"\n');

	const tsRoot = join(root, "frontend-ts");
	mkdirSync(tsRoot);
	writeFileSync(join(tsRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	const tsFile = join(tsRoot, "main.ts");
	writeFileSync(tsFile, "export function tsOnly(a: number, b: number): number {\n\treturn a + b;\n}\n");

	return { root, goFile, pythonFile, tsFile };
}

describe("a polyglot repo (Go + Python + TypeScript subprojects under one parent root)", () => {
	it("descriptorForExtension resolves each subproject's own language independently of its siblings", () => {
		expect(descriptorForExtension(".go")?.languageId).toBe("go");
		expect(descriptorForExtension(".py")?.languageId).toBe("python");
		expect(descriptorForExtension(".ts")?.languageId).toBe("typescript");
	});

	it("three real servers, each rooted at its own subproject, resolve correctly at once with no cross-language contamination, within a real combined resource budget", async () => {
		const fixture = buildPolyglotRepo();
		const goIndex = new LspSymbolIndex(join(fixture.root, "backend-go"), GO_DESCRIPTOR, "main.go");
		const pythonIndex = new LspSymbolIndex(join(fixture.root, "scripts-python"), PYTHON_DESCRIPTOR, "main.py");
		const tsIndex = new LspSymbolIndex(join(fixture.root, "frontend-ts"), TYPESCRIPT_DESCRIPTOR, "main.ts");

		try {
			const [goSymbols, pythonSymbols, tsSymbols] = await Promise.all([
				documentSymbols(goIndex, fixture.goFile),
				documentSymbols(pythonIndex, fixture.pythonFile),
				documentSymbols(tsIndex, fixture.tsFile),
			]);

			// Each server only ever knows its own subproject's symbol -- no leakage across roots.
			expect(goSymbols.map((s) => s.name)).toEqual(["goOnly"]);
			expect(pythonSymbols.map((s) => s.name)).toEqual(["python_only"]);
			expect(tsSymbols.map((s) => s.name)).toContain("tsOnly");

			const rssKbTotals = [goIndex.processId, pythonIndex.processId, tsIndex.processId].map((pid) =>
				pid !== undefined ? (measureProcessTreeRssKb(pid) ?? 0) : 0,
			);
			const totalRssMb = rssKbTotals.reduce((sum, kb) => sum + kb, 0) / 1024;
			// Measured baselines (language-server-cold-start.ts benchmark): go ~420MB, python
			// ~150MB, typescript ~570MB against a trivial fixture -- ~1140MB combined. 2000MB
			// keeps real margin while still catching a genuine multi-server explosion.
			expect(totalRssMb).toBeLessThan(2000);
		} finally {
			await Promise.all([goIndex.close(), pythonIndex.close(), tsIndex.close()]);
			rmSync(fixture.root, { recursive: true, force: true });
		}
	}, 30_000);
});
