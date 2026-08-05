/**
 * Service-level proof that rawRead, exactEdit, and the default LspSymbolIndex share ONE
 * content-addressed cache instance -- the real point of this task, not just that each
 * individually accepts a ContentCachePort (already proven directly in
 * test/adapters/lsp/lsp-symbol-index.test.ts's own content-cache describe block).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/adapters/lsp/lsp-symbol-index.ts";
import { InMemoryContentCache } from "../src/content-cache/in-memory-content-cache.ts";
import { contentHashOf } from "../src/content-identity/content-hash.ts";
import type { LanguageServerProvisionerPort } from "../src/lsp-provisioning/port.ts";
import { createLectorService, type LectorService } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-content-cache-sharing-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "a.ts"), "export function shared(): number {\n\treturn 1;\n}\n");
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["src"] }));
	return root;
}

describe("createLectorService's shared content cache", () => {
	it("warms the shared cache from rawRead, reused by the default LspSymbolIndex's own construction", async () => {
		fixtureRoot = buildFixture();
		const contentCache = new InMemoryContentCache();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createContentCache: () => contentCache,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile, { contentCache }),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const read = await service.dispatch("workspace.rawRead", { workspaceId, path: "src/a.ts" });
		await expect(contentCache.get(read.hash)).resolves.toMatchObject({ rawContent: read.content });
	});

	it("warms the shared cache from exactEdit with the NEW content's hash", async () => {
		fixtureRoot = buildFixture();
		const contentCache = new InMemoryContentCache();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createContentCache: () => contentCache });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const outcome = await service.dispatch("workspace.exactEdit", {
			workspaceId,
			path: "src/b.ts",
			expectedHash: null,
			content: "export const fresh = true;\n",
		});

		await expect(contentCache.get(outcome.newHash)).resolves.toMatchObject({ rawContent: "export const fresh = true;\n" });
	});

	it("does not invoke managed LSP provisioning for filesystem-only reads and writes", async () => {
		fixtureRoot = buildFixture();
		let provisionCalls = 0;
		const provisioner: LanguageServerProvisionerPort = {
			async ensureInstalled() {
				provisionCalls += 1;
				return { kind: "unavailable", reason: "must not be reached" };
			},
		};
		service = createLectorService(new Map(), { allowDynamicOnly: true, languageServerProvisioner: provisioner });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		await service.dispatch("workspace.rawRead", { workspaceId, path: "src/a.ts" });
		await service.dispatch("workspace.exactEdit", { workspaceId, path: "src/b.ts", expectedHash: null, content: "export const fresh = true;\n" });

		expect(provisionCalls).toBe(0);
	});

	it("a real query through the default LspSymbolIndex warms the exact same shared instance rawRead reads from", async () => {
		fixtureRoot = buildFixture();
		const contentCache = new InMemoryContentCache();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createContentCache: () => contentCache });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const absolutePath = join(fixtureRoot, "src", "a.ts");
		await service.dispatch("workspace.documentSymbols", { workspaceId, path: absolutePath });

		const realContent = "export function shared(): number {\n\treturn 1;\n}\n";
		await expect(contentCache.get(contentHashOf(realContent))).resolves.toMatchObject({ rawContent: realContent });
	}, 20_000);
});
