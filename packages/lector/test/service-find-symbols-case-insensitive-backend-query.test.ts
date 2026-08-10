/**
 * Live stress-test finding: rust-analyzer's own workspace/symbol never surfaced a real
 * "normalize" symbol at all for the query "Normalize" -- find_symbols' own documented contract
 * (case-insensitive substring) was violated not by Lector's own post-filtering
 * (normalizeSymbolSearchResult already matches case-insensitively) but by leaking the caller's
 * original casing straight through to a backend whose own internal ranking is case-sensitive.
 * No amount of post-filtering can recover a result the backend never returned in the first place.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClosableSymbolIndex, createLectorService, type LectorService } from "../src/service.ts";
import { symbolSearchResult, TEST_SEMANTIC_PROVENANCE } from "./support/intelligence-provenance.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-find-symbols-case-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "lib.rs"), "pub fn normalize(x: f64) -> f64 { x }\n");
	return root;
}

/** A case-sensitive fake backend, mirroring rust-analyzer's own observed live behavior: it only ever returns a symbol whose name shares the query's exact case pattern. */
function caseSensitiveIndex(receivedQueries: string[]): ClosableSymbolIndex {
	return {
		provenance: TEST_SEMANTIC_PROVENANCE,
		findSymbols(query) {
			receivedQueries.push(query);
			// Only ever "finds" the real symbol when asked with its own exact lowercase spelling --
			// a query containing any uppercase character returns nothing, exactly like the live
			// rust-analyzer finding this test reproduces.
			if (query !== query.toLowerCase()) return Promise.resolve(symbolSearchResult([]));
			if (!"normalize".includes(query)) return Promise.resolve(symbolSearchResult([]));
			return Promise.resolve(symbolSearchResult([{ name: "normalize", kind: "function", location: { path: "src/lib.rs", line: 1, character: 8 } }]));
		},
		async close() {},
	};
}

describe("workspace.findSymbols sends a case-neutral query to the backend", () => {
	it("still finds a real symbol when the caller's query has different casing than the backend requires internally", async () => {
		fixtureRoot = buildFixture();
		const receivedQueries: string[] = [];
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => caseSensitiveIndex(receivedQueries) });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		const result = await service.dispatch("workspace.findSymbols", { workspaceId, query: "Normalize", maxResults: 10 });

		expect(receivedQueries).toEqual(["normalize"]);
		expect(result.symbols.map((symbol) => symbol.name)).toEqual(["normalize"]);
	});
});
