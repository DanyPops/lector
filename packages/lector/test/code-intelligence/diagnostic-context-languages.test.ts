import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PYTHON_DESCRIPTOR, RUST_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";

let root: string | undefined;
let index: LspSymbolIndex | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("reference-language diagnostic controls", () => {
	for (const configured of [true, false]) {
		it(`Rust project metadata ${configured ? "present" : "missing"}`, async () => {
			root = mkdtempSync(join(tmpdir(), "lector-rust-context-"));
			mkdirSync(join(root, "src"));
			const path = join(root, "src/lib.rs");
			writeFileSync(path, "pub fn first(values: &[f64]) -> f64 { -values[0] }\npub fn sample() -> f64 { first(&[2.0, 3.0]) }\n");
			if (configured) writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "context_control"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n');
			execFileSync("rustc", ["--edition=2021", "--crate-type=lib", "--emit=metadata", "-o", join(root, "control.rmeta"), path], {
				cwd: root,
				timeout: 30_000,
				maxBuffer: 65_536,
			});
			index = new LspSymbolIndex(root, RUST_DESCRIPTOR, "src/lib.rs");
			const diagnostics = await index.diagnostics(path);
			const context = index.diagnosticContext(path);
			expect(context.confidence).toBe(configured ? "reported-ready" : "degraded");
			if (configured) expect(diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
			else expect(context.setupFindings.some(({ kind }) => kind === "project-metadata")).toBe(true);
			expect(index.provenance.fidelity).toBe("semantic");
		}, 60_000);
	}

	for (const configured of [true, false]) {
		it(`Python environment ${configured ? "default" : "missing"}`, async () => {
			root = mkdtempSync(join(tmpdir(), "lector-python-context-"));
			const path = join(root, "main.py");
			writeFileSync(path, 'value: int = "bad"\n');
			writeFileSync(
				join(root, "pyrightconfig.json"),
				JSON.stringify({ include: ["main.py"], ...(configured ? {} : { venvPath: "missing-environments", venv: "sample" }) }),
			);
			index = new LspSymbolIndex(root, PYTHON_DESCRIPTOR, "main.py");
			const diagnostics = await index.diagnostics(path);
			expect(diagnostics.some(({ code }) => code === "reportAssignmentType")).toBe(true);
			const context = index.diagnosticContext(path);
			expect(context.confidence).toBe(configured ? "unknown" : "degraded");
			if (!configured) expect(context.setupFindings.some(({ kind }) => kind === "interpreter")).toBe(true);
		}, 30_000);
	}
});
