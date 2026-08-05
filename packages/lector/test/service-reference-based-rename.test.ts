/**
 * Service-level wiring for workspace.referenceBasedRename against a real, live
 * typescript-language-server -- document symbols, findReferences, and the tree-sitter import-
 * specifier scan are each already covered directly elsewhere; this proves they're glued
 * together correctly end to end, against real files and a real running server.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { createLectorService, type LectorService, ReferenceBasedRenameRequiresFreshGraph } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-reference-based-rename-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "math.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	writeFileSync(join(root, "src", "consumer.ts"), 'import { add } from "./math";\n\nexport function sum(): number {\n\treturn add(1, 2);\n}\n');
	writeFileSync(join(root, "src", "unrelated.ts"), "export const unrelated = true;\n");
	writeFileSync(
		join(root, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
	);
	return root;
}

async function buildService(): Promise<{ service: LectorService; workspaceId: string }> {
	const service = createLectorService(new Map(), {
		allowDynamicOnly: true,
		createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
	});
	const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot as string });
	return { service, workspaceId };
}

describe("createLectorService's workspace.referenceBasedRename", () => {
	it("refuses outright when the symbol graph has never been populated -- no-completed-generation counts as not fully cached", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;

		const attempt = service.dispatch("workspace.referenceBasedRename", {
			workspaceId: built.workspaceId,
			fromPath: join(fixtureRoot, "src", "math.ts"),
			toPath: join(fixtureRoot, "src", "arithmetic.ts"),
			maxFiles: 10,
			maxSymbolsPerFile: 10,
		});

		await expect(attempt).rejects.toBeInstanceOf(ReferenceBasedRenameRequiresFreshGraph);
	}, 20_000);

	it("moves the file and rewrites the real importing file's specifier, leaving an unrelated file untouched", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId: built.workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		const outcome = await service.dispatch("workspace.referenceBasedRename", {
			workspaceId: built.workspaceId,
			fromPath: join(fixtureRoot, "src", "math.ts"),
			toPath: join(fixtureRoot, "src", "arithmetic.ts"),
			maxFiles: 10,
			maxSymbolsPerFile: 10,
		});

		expect(outcome.movedTo).toBe(join(fixtureRoot, "src", "arithmetic.ts"));
		expect(outcome.filesUpdated).toEqual([join(fixtureRoot, "src", "consumer.ts")]);
		expect(outcome.caveats.length).toBeGreaterThan(0);

		expect(() => readFileSync(join(fixtureRoot as string, "src", "math.ts"), "utf8")).toThrow();
		expect(readFileSync(join(fixtureRoot, "src", "arithmetic.ts"), "utf8")).toContain("export function add");
		expect(readFileSync(join(fixtureRoot, "src", "consumer.ts"), "utf8")).toContain('from "./arithmetic"');
		expect(readFileSync(join(fixtureRoot, "src", "unrelated.ts"), "utf8")).toBe("export const unrelated = true;\n");
	}, 20_000);

	it("refuses outright when queried against different bounds than the graph was actually populated with -- shares the exact same not-cached guard as never-populated", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId: built.workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		const attempt = service.dispatch("workspace.referenceBasedRename", {
			workspaceId: built.workspaceId,
			fromPath: join(fixtureRoot, "src", "math.ts"),
			toPath: join(fixtureRoot, "src", "arithmetic.ts"),
			// Different bounds than the graph was populated with -- cacheStatusHandler's own
			// "bounds-changed" reason, a different not-cached member than the other test's
			// no-completed-generation, proving the guard (status !== "cached") isn't accidentally
			// specific to one literal reason.
			maxFiles: 5,
			maxSymbolsPerFile: 10,
		});

		await expect(attempt).rejects.toBeInstanceOf(ReferenceBasedRenameRequiresFreshGraph);
	}, 20_000);
});
