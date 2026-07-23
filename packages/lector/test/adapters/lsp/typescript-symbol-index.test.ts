/**
 * Dogfood: a real typescript-language-server process, queried against
 * Lector's own source tree, not a fixture. Walking-skeleton step 5's
 * "one symbol query" (lector-generic-capability-design-kkje).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { findWorkspaceSymbols } from "../../../src/domain/find-workspace-symbols.ts";
import { TypescriptSymbolIndex } from "../../../src/adapters/lsp/typescript-symbol-index.ts";

const LECTOR_ROOT = new URL("../../..", import.meta.url).pathname;

let index: TypescriptSymbolIndex | undefined;
afterEach(async () => {
	await index?.close();
	index = undefined;
});

describe("TypescriptSymbolIndex", () => {
	it("finds a real, known symbol in Lector's own source via a live typescript-language-server", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");

		const results = await findWorkspaceSymbols(index, "exactEdit");

		// Real tsserver behavior, not an assumption: navto only surfaces symbols in files it
		// has actually loaded. With only the seed file (src/index.ts) opened, the match found
		// is the barrel's re-export binding (kind "variable"), not exact-edit.ts's original
		// `function` declaration -- tsserver never independently opened that file. Still a
		// materially useful result: it correctly names and locates the symbol.
		const match = results.find((symbol) => symbol.name === "exactEdit");
		expect(match).toBeDefined();
		expect(match?.location.path).toContain("lector");
		expect(match?.location.line).toBeGreaterThan(0);
	}, 20_000);

	it("returns an empty array for a query matching nothing, not an error", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");

		const results = await findWorkspaceSymbols(index, "ThisSymbolDefinitelyDoesNotExistAnywhere");

		expect(results).toEqual([]);
	}, 20_000);
});
