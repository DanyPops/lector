import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CPP_DESCRIPTOR, GO_DESCRIPTOR, PYTHON_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { discoverWorkspaceSourceCoverage } from "../../src/code-intelligence/lsp/discover-seed-file.ts";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function freshRoot(): string {
	root = mkdtempSync(join(tmpdir(), "lector-polyglot-source-selection-"));
	return root;
}

describe("discoverWorkspaceSourceCoverage", () => {
	it("reports a language with no matching file anywhere as confirmed absent, not truncated, once the whole bounded tree is covered", () => {
		const dir = freshRoot();
		writeFileSync(join(dir, "main.py"), "value = 1\n");

		const coverage = discoverWorkspaceSourceCoverage(dir, [PYTHON_DESCRIPTOR, GO_DESCRIPTOR]);

		expect(coverage.discovered.map(({ descriptor }) => descriptor.languageId)).toEqual(["python"]);
		expect(coverage.omittedLanguageIds).toEqual(["go"]);
		expect(coverage.truncated).toBe(false);
	});

	it("reports every eligible language as discovered with no omissions when all are present", () => {
		const dir = freshRoot();
		writeFileSync(join(dir, "main.py"), "value = 1\n");
		writeFileSync(join(dir, "engine.c"), "int main(void) { return 0; }\n");

		const coverage = discoverWorkspaceSourceCoverage(dir, [PYTHON_DESCRIPTOR, CPP_DESCRIPTOR]);

		expect(coverage.omittedLanguageIds).toEqual([]);
		expect(coverage.truncated).toBe(false);
	});

	it("marks an omitted language as truncated, not confirmed-absent, when the shared scan hits its entry budget before it could rule the language out", () => {
		const dir = freshRoot();
		// Only Python is present; Go never appears anywhere. But a huge early alphabetical subtree
		// exhausts the shared scan budget before the traversal can exhaustively prove Go's absence.
		writeFileSync(join(dir, "main.py"), "value = 1\n");
		for (let i = 0; i < 3_000; i++) {
			mkdirSync(join(dir, "assets"), { recursive: true });
			writeFileSync(join(dir, "assets", `f-${String(i).padStart(5, "0")}.bin`), "");
		}

		const coverage = discoverWorkspaceSourceCoverage(dir, [PYTHON_DESCRIPTOR, GO_DESCRIPTOR]);

		expect(coverage.discovered.map(({ descriptor }) => descriptor.languageId)).toEqual(["python"]);
		expect(coverage.omittedLanguageIds).toEqual(["go"]);
		expect(coverage.truncated).toBe(true);
	});
});
