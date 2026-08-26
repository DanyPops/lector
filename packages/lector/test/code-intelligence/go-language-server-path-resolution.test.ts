import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { documentSymbols } from "../../src/code-intelligence/document-symbols.ts";
import { GO_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";

let lsp: LspSymbolIndex | undefined;
let root: string | undefined;

afterEach(async () => {
	await lsp?.close();
	lsp = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("gopls spawn PATH resolution", () => {
	/**
	 * Characterizes a real reported gap: gopls resolves fine from an interactive shell's own
	 * PATH, but the long-lived daemon process spawning it can carry a different, narrower PATH
	 * (captured at daemon start, before a later shell-profile change added gopls's directory).
	 * GO_DESCRIPTOR's system-binary launch resolves "gopls" against whatever PATH the spawning
	 * process currently holds, with no fallback when that directory is absent -- reproduced here
	 * by removing gopls's own real directory from PATH before spawning, rather than by faking a
	 * missing binary, so this exercises the exact resolution gap rather than a simulated one.
	 * Update or remove this test once Lector gains either login-shell PATH resolution at daemon
	 * startup or an explicit per-language-server binary path override.
	 */
	it("fails with a bare ENOENT-style error when gopls's own directory is absent from the spawning process's PATH", async () => {
		const goplsPath = Bun.which("gopls");
		if (!goplsPath) throw new Error("gopls must be installed for this test to exercise the real spawn resolution gap");
		const goplsDir = dirname(goplsPath);

		root = mkdtempSync(join(tmpdir(), "lector-go-path-repro-"));
		writeFileSync(join(root, "go.mod"), "module example.com/pathrepro\n\ngo 1.22\n");
		writeFileSync(join(root, "main.go"), "package main\n\nfunc main() {}\n");

		const originalPath = process.env.PATH;
		const restrictedPath = (originalPath ?? "")
			.split(delimiter)
			.filter((entry) => entry !== goplsDir)
			.join(delimiter);
		expect(Bun.which("gopls", { PATH: restrictedPath })).toBeNull();

		process.env.PATH = restrictedPath;
		try {
			lsp = new LspSymbolIndex(root, GO_DESCRIPTOR, "main.go");
			await expect(documentSymbols(lsp, join(root, "main.go"))).rejects.toThrow(/gopls/i);
		} finally {
			process.env.PATH = originalPath;
		}
	}, 30_000);
});
