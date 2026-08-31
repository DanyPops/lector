import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GO_DESCRIPTOR, TYPESCRIPT_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";

let root: string | undefined;
let index: LspSymbolIndex | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("LSP code actions", () => {
	it("retrieves and resolves a real TypeScript quick fix", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-code-action-ts-"));
		mkdirSync(join(root, "src"));
		const path = join(root, "src", "action.ts");
		writeFileSync(path, "export function load(): void {\n\tawait Promise.resolve();\n}\n");
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, path);
		const diagnostics = await index.diagnostics(path);
		const target = diagnostics.find(({ code }) => code === 1308);
		expect(target).toBeDefined();

		const actions = await index.codeActions({
			path,
			range: target?.range ?? { start: { line: 2, character: 2 }, end: { line: 2, character: 7 } },
			diagnostics: target ? [target] : [],
			only: ["quickfix"],
			maxActions: 10,
			timeoutMs: 10_000,
		});
		const action = actions.find(({ title }) => /async/i.test(title));
		expect(action).toBeDefined();
		const resolved = action ? await index.resolveCodeAction(action, 10_000) : undefined;
		expect(resolved?.edit?.operations.some((operation) => operation.kind === "text" && operation.path === path)).toBe(true);
	}, 30_000);

	it("retrieves a real gopls import quick fix", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-code-action-go-"));
		const path = join(root, "main.go");
		writeFileSync(join(root, "go.mod"), "module fixture/codeaction\n\ngo 1.22\n");
		writeFileSync(path, 'package main\n\nfunc main() {\n\tfmt.Println("hello")\n}\n');
		index = new LspSymbolIndex(root, GO_DESCRIPTOR, path);
		const diagnostics = await index.diagnostics(path);
		const target = diagnostics.find(({ message }) => /undefined: fmt/i.test(message));
		expect(target).toBeDefined();
		const actions = await index.codeActions({
			path,
			range: target?.range ?? { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } },
			diagnostics: target ? [target] : [],
			only: ["quickfix"],
			maxActions: 10,
			timeoutMs: 10_000,
		});
		expect(actions.some(({ title, edit }) => /import|fmt/i.test(title) && edit?.operations.some((operation) => operation.kind === "text"))).toBe(true);
	}, 60_000);
});
