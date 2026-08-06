import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GO_DESCRIPTOR, type LanguageServerDescriptor } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { LanguageServerWorkspaceNotReady, LspSymbolIndex } from "../../../src/code-intelligence/lsp/lsp-symbol-index.ts";

const PROGRESS_GATED_SERVER = fileURLToPath(new URL("../../support/progress-gated-lsp-server.ts", import.meta.url));
const PROGRESS_GATED_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "typescript",
	backendId: "progress-gated-fixture",
	extensions: [".ts"],
	launch: { kind: "system-binary", command: process.execPath },
	args: [PROGRESS_GATED_SERVER],
	rootMarkers: [],
	commonSeedCandidates: ["seed.ts"],
	settleMs: 0,
};

let root: string | undefined;
let index: LspSymbolIndex | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("LspSymbolIndex workspace readiness", () => {
	it("waits for active work-done progress before a workspace-wide query", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-progress-gated-"));
		writeFileSync(join(root, "seed.ts"), "export function readySymbol() {}\n");
		index = new LspSymbolIndex(root, PROGRESS_GATED_DESCRIPTOR, "seed.ts");

		const result = await index.findSymbols("readySymbol");

		expect(result.symbols.map((symbol) => symbol.name)).toContain("readySymbol");
		expect(index.latestProgress.get("initial-index")).toEqual({ kind: "end" });
	}, 10_000);

	it("waits for active work-done progress before a project-wide references query", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-progress-gated-"));
		const seed = join(root, "seed.ts");
		writeFileSync(seed, "export function readySymbol() {}\n");
		index = new LspSymbolIndex(root, PROGRESS_GATED_DESCRIPTOR, "seed.ts");

		const references = await index.findReferences({ path: seed, line: 1, character: 17 }, true);

		expect(references).toHaveLength(1);
		expect(index.latestProgress.get("initial-index")).toEqual({ kind: "end" });
	}, 10_000);

	it("fails closed at the explicit readiness bound instead of returning an incomplete result", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-progress-gated-"));
		writeFileSync(join(root, "seed.ts"), "export function readySymbol() {}\n");
		index = new LspSymbolIndex(root, { ...PROGRESS_GATED_DESCRIPTOR, args: [PROGRESS_GATED_SERVER, "--never-finish"] }, "seed.ts", {
			workspaceReadyTimeoutMs: 50,
		});

		let failure: unknown;
		try {
			await index.findSymbols("readySymbol");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(LanguageServerWorkspaceNotReady);
		if (failure instanceof LanguageServerWorkspaceNotReady) {
			expect(failure.timeoutMs).toBe(50);
			expect(failure.activeProgressCount).toBe(1);
			expect(failure.progressTrackingSaturated).toBe(false);
		}
	}, 10_000);

	it("observes a real gopls cold-start progress lifecycle without losing the workspace symbol", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-gopls-readiness-"));
		writeFileSync(join(root, "go.mod"), "module example.com/readiness\n\ngo 1.23\n");
		writeFileSync(join(root, "main.go"), "package main\n\nfunc main() {}\n");
		for (let index = 0; index < 48; index += 1) {
			const packageDirectory = join(root, `pkg${String(index).padStart(2, "0")}`);
			mkdirSync(packageDirectory);
			const symbol = index === 47 ? "ColdStartTarget" : `PackageSymbol${index}`;
			writeFileSync(join(packageDirectory, "value.go"), `package pkg${String(index).padStart(2, "0")}\n\nfunc ${symbol}() int { return ${index} }\n`);
		}
		index = new LspSymbolIndex(root, { ...GO_DESCRIPTOR, settleMs: 0 }, "main.go");

		const result = await index.findSymbols("ColdStartTarget");

		expect(result.symbols.map((symbol) => symbol.name)).toContain("ColdStartTarget");
		expect([...index.latestProgress.values()].some((value) => isProgressEnd(value))).toBe(true);
	}, 30_000);
});

function isProgressEnd(value: unknown): boolean {
	return typeof value === "object" && value !== null && "kind" in value && value.kind === "end";
}
