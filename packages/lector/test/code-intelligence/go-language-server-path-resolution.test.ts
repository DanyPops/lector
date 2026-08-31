import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { diagnostics } from "../../src/code-intelligence/diagnostics.ts";
import { documentSymbols } from "../../src/code-intelligence/document-symbols.ts";
import { findReferences } from "../../src/code-intelligence/find-references.ts";
import { goToDefinition } from "../../src/code-intelligence/go-to-definition.ts";
import { hoverAt } from "../../src/code-intelligence/hover-at.ts";
import { GO_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LanguageServerExecutableUnavailable, LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { outgoingCalls } from "../../src/symbol-graph/outgoing-calls.ts";
import { findWorkspaceSymbols } from "../../src/workspace/find-workspace-symbols.ts";
import { findPositionOf } from "../support/find-position.ts";

let lsp: LspSymbolIndex | undefined;
let root: string | undefined;

afterEach(async () => {
	await lsp?.close();
	lsp = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("gopls spawn PATH resolution", () => {
	it("discovers gopls when the daemon PATH omits it", async () => {
		const goplsPath = Bun.which("gopls");
		if (!goplsPath) throw new Error("gopls must be installed for this test to exercise the real spawn resolution gap");
		const goplsDir = dirname(goplsPath);

		root = mkdtempSync(join(tmpdir(), "lector-go-path-repro-"));
		writeFileSync(join(root, "go.mod"), "module example.com/pathrepro\n\ngo 1.22\n");
		const mainFile = join(root, "main.go");
		writeFileSync(mainFile, "package main\n\nfunc helper() int { return 1 }\n\nfunc main() { helper(); helper() }\n");

		const originalPath = process.env.PATH;
		const restrictedPath = (originalPath ?? "")
			.split(delimiter)
			.filter((entry) => entry !== goplsDir)
			.join(delimiter);
		expect(Bun.which("gopls", { PATH: restrictedPath })).toBeNull();

		process.env.PATH = restrictedPath;
		try {
			lsp = new LspSymbolIndex(root, GO_DESCRIPTOR, "main.go");
			const symbols = await documentSymbols(lsp, mainFile);
			expect(symbols).toContainEqual(expect.objectContaining({ name: "main", kind: "function" }));
			expect((await findWorkspaceSymbols(lsp, "helper")).symbols).toContainEqual(expect.objectContaining({ name: "helper" }));
			const declaration = findPositionOf(mainFile, "helper() int");
			const declarationPosition = { path: mainFile, line: declaration.line, character: declaration.character };
			expect((await hoverAt(lsp, declarationPosition))?.contents).toContain("helper");
			expect((await findReferences(lsp, declarationPosition, true)).length).toBeGreaterThanOrEqual(3);
			const usage = findPositionOf(mainFile, "helper();");
			expect(await goToDefinition(lsp, { path: mainFile, ...usage })).toContainEqual(expect.objectContaining({ path: mainFile, line: declaration.line }));
			const main = findPositionOf(mainFile, "main() {");
			expect((await outgoingCalls(lsp, { path: mainFile, ...main })).some(({ to }) => to.name === "helper")).toBe(true);
			expect(await diagnostics(lsp, mainFile)).toEqual([]);
			expect(await lsp.prepareRename(declarationPosition)).not.toBeNull();
			expect((await lsp.rename(declarationPosition, "renamedHelper")).operations).toContainEqual(expect.objectContaining({ kind: "text", path: mainFile }));
			expect(lsp.provenance).toMatchObject({ backend: "gopls", authority: "language-server" });
		} finally {
			process.env.PATH = originalPath;
		}
	}, 30_000);

	it("reports the explicit gopls override when discovery fails", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-go-path-error-"));
		writeFileSync(join(root, "go.mod"), "module example.com/patherror\n\ngo 1.22\n");
		writeFileSync(join(root, "main.go"), "package main\n\nfunc main() {}\n");
		const originalOverride = process.env.LECTOR_GOPLS_PATH;
		process.env.LECTOR_GOPLS_PATH = join(root, "missing-gopls");
		try {
			lsp = new LspSymbolIndex(root, GO_DESCRIPTOR, "main.go");
			await expect(documentSymbols(lsp, join(root, "main.go"))).rejects.toMatchObject({
				name: LanguageServerExecutableUnavailable.name,
				message: expect.stringContaining("set LECTOR_GOPLS_PATH"),
			});
		} finally {
			if (originalOverride === undefined) delete process.env.LECTOR_GOPLS_PATH;
			else process.env.LECTOR_GOPLS_PATH = originalOverride;
		}
	});
});
