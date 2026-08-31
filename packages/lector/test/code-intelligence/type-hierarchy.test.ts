import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { prepareTypeHierarchy } from "../../src/code-intelligence/type-hierarchy.ts";
import { findPositionOf } from "../support/find-position.ts";

let root: string | undefined;
let index: LspSymbolIndex | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("LSP type hierarchy", () => {
	it("reports the real TypeScript server's missing capability distinctly", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-type-hierarchy-ts-"));
		mkdirSync(join(root, "src"));
		const path = join(root, "src", "hierarchy.ts");
		writeFileSync(path, "export interface Animal {}\nexport class Dog implements Animal {}\nexport class GuideDog extends Dog {}\n");
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, path);
		const dog = findPositionOf(path, "Dog implements");
		const at = { path, line: dog.line, character: dog.character + 1 };

		await expect(prepareTypeHierarchy(index, at)).rejects.toMatchObject({
			name: "LanguageServerTypeHierarchyUnavailable",
			backendId: "typescript-language-server",
		});
	}, 30_000);

	it("distinguishes an unsupported server from an empty hierarchy", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-type-hierarchy-unsupported-"));
		const path = join(root, "seed.ts");
		writeFileSync(path, "export const seed = 1;\n");
		index = new LspSymbolIndex(
			root,
			{
				...TYPESCRIPT_DESCRIPTOR,
				backendId: "unsupported-fixture",
				launch: { kind: "system-binary", command: process.execPath },
				args: [join(import.meta.dir, "../support/evil-lsp-server.ts")],
			},
			path,
		);

		await expect(prepareTypeHierarchy(index, { path, line: 1, character: 14 })).rejects.toMatchObject({ name: "LanguageServerTypeHierarchyUnavailable" });
	}, 20_000);
});
