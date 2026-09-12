import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";

const server = fileURLToPath(new URL("../support/context-diagnostics-lsp-server.ts", import.meta.url));
let root: string | undefined;
let index: LspSymbolIndex | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("Rust/Python incomplete-environment diagnostic matrix", () => {
	for (const [scenario, confidence, kinds] of [
		["rust-missing", "degraded", ["standard-library"]],
		["rust-healthy", "reported-ready", []],
		["python-missing", "degraded", ["interpreter"]],
		["python-healthy", "unknown", []],
		["stale", "degraded", ["stale-diagnostics"]],
	] as const) {
		it(`${scenario} preserves native diagnostics`, async () => {
			root = mkdtempSync(join(tmpdir(), "lector-diagnostic-context-"));
			const source = "source\n";
			const path = join(root, "file.ts");
			writeFileSync(path, source);
			index = new LspSymbolIndex(root, {
				languageId: "fixture",
				backendId: "fixture",
				extensions: [".ts"],
				launch: { kind: "system-binary", command: "bun" },
				args: [server, scenario],
				rootMarkers: [],
				commonSeedCandidates: [],
				settleMs: 0,
			});
			const diagnostics = await index.diagnostics(path);
			expect(diagnostics).toMatchObject([{ message: "native type mismatch", code: "native-code", severity: "error", source: "fixture" }]);
			const context = index.diagnosticContext(path);
			expect(context.confidence).toBe(confidence);
			expect(context.setupFindings.map((finding) => finding.kind)).toEqual([...kinds]);
			expect(context.document.synchronizedContentHash).toBe(contentHashOf(source));
			expect(context.document.synchronizedVersion).toBe(1);
			expect(context.document.publishedVersion).toBe(scenario === "stale" ? 0 : 1);
			expect(context.server.version).toBe("1.2.3");
			expect(index.provenance.fidelity).toBe("semantic");
		}, 10_000);
	}
});
