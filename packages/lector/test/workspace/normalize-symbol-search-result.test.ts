import { describe, expect, it } from "bun:test";
import { normalizeSymbolSearchResult } from "../../src/workspace/normalize-symbol-search-result.ts";
import type { WorkspaceSymbol } from "../../src/workspace/workspace-symbol.ts";
import { symbolSearchResult } from "../support/intelligence-provenance.ts";

const ROOT = "/repo/project";

function symbol(overrides: { name: string; path: string; kind?: string; line?: number; character?: number; containerName?: string }): WorkspaceSymbol {
	return {
		name: overrides.name,
		kind: overrides.kind ?? "function",
		location: { path: overrides.path, line: overrides.line ?? 1, character: overrides.character ?? 1 },
		containerName: overrides.containerName,
	};
}

describe("normalizeSymbolSearchResult", () => {
	it("keeps a case-insensitive substring match on the symbol name", () => {
		const result = symbolSearchResult([symbol({ name: "Normalize", path: `${ROOT}/src/a.ts` })]);
		const normalized = normalizeSymbolSearchResult(result, "normal", ROOT, 100);
		expect(normalized.symbols.map((s) => s.name)).toEqual(["Normalize"]);
	});

	it("drops a backend hit whose name does not contain the query", () => {
		const result = symbolSearchResult([symbol({ name: "marshaledSize", path: `${ROOT}/src/a.go` }), symbol({ name: "Normalize", path: `${ROOT}/src/b.go` })]);
		const normalized = normalizeSymbolSearchResult(result, "normal", ROOT, 100);
		expect(normalized.symbols.map((s) => s.name)).toEqual(["Normalize"]);
	});

	it("drops a symbol whose path falls outside the workspace root -- the gopls stdlib/module-cache leak", () => {
		const result = symbolSearchResult([
			symbol({ name: "Normalize", path: "/usr/lib/golang/src/strings/strings.go" }),
			symbol({ name: "Normalize", path: `${ROOT}/src/b.go` }),
		]);
		const normalized = normalizeSymbolSearchResult(result, "normal", ROOT, 100);
		expect(normalized.symbols).toHaveLength(1);
		expect(normalized.symbols[0]?.location.path).toBe(`${ROOT}/src/b.go`);
	});

	it("does not treat a sibling directory that merely shares a name prefix as inside the root", () => {
		const result = symbolSearchResult([symbol({ name: "Normalize", path: "/repo/project-other/src/a.go" })]);
		const normalized = normalizeSymbolSearchResult(result, "normal", ROOT, 100);
		expect(normalized.symbols).toHaveLength(0);
	});

	it("keeps a workspace-relative path from a structural fallback backend (typescript-compiler, tree-sitter)", () => {
		const result = symbolSearchResult([symbol({ name: "add", path: "core/algebra.ts" })]);
		const normalized = normalizeSymbolSearchResult(result, "add", ROOT, 100);
		expect(normalized.symbols).toHaveLength(1);
	});

	it("drops a workspace-relative path that escapes the root via ../ segments", () => {
		const result = symbolSearchResult([symbol({ name: "add", path: "../outside/add.ts" })]);
		const normalized = normalizeSymbolSearchResult(result, "add", ROOT, 100);
		expect(normalized.symbols).toHaveLength(0);
	});

	it("keeps a symbol located at the workspace root path itself", () => {
		const result = symbolSearchResult([symbol({ name: "Normalize", path: ROOT })]);
		const normalized = normalizeSymbolSearchResult(result, "normal", ROOT, 100);
		expect(normalized.symbols).toHaveLength(1);
	});

	it("deduplicates identical name/kind/location entries", () => {
		const duplicate = symbol({ name: "add", path: `${ROOT}/src/a.ts`, line: 3, character: 1 });
		const result = symbolSearchResult([duplicate, { ...duplicate }]);
		const normalized = normalizeSymbolSearchResult(result, "add", ROOT, 100);
		expect(normalized.symbols).toHaveLength(1);
	});

	it("keeps distinct symbols with the same name at different locations", () => {
		const result = symbolSearchResult([symbol({ name: "add", path: `${ROOT}/src/a.ts`, line: 1 }), symbol({ name: "add", path: `${ROOT}/src/b.ts`, line: 1 })]);
		const normalized = normalizeSymbolSearchResult(result, "add", ROOT, 100);
		expect(normalized.symbols).toHaveLength(2);
	});

	it("truncates to maxResults and marks the result truncated once real matches exceed the caller's bound", () => {
		const result = symbolSearchResult([
			symbol({ name: "add1", path: `${ROOT}/a.ts` }),
			symbol({ name: "add2", path: `${ROOT}/b.ts` }),
			symbol({ name: "add3", path: `${ROOT}/c.ts` }),
		]);
		const normalized = normalizeSymbolSearchResult(result, "add", ROOT, 2);
		expect(normalized.symbols).toHaveLength(2);
		expect(normalized.truncated).toBe(true);
	});

	it("does not report truncated just because filtering removed irrelevant or out-of-root hits", () => {
		const result = symbolSearchResult([
			symbol({ name: "add", path: `${ROOT}/a.ts` }),
			symbol({ name: "unrelated", path: `${ROOT}/b.ts` }),
			symbol({ name: "add", path: "/usr/lib/golang/add.go" }),
		]);
		const normalized = normalizeSymbolSearchResult(result, "add", ROOT, 100);
		expect(normalized.symbols).toHaveLength(1);
		expect(normalized.truncated).toBe(false);
	});

	it("preserves the backend's own truncated=true signal even when the kept set is small", () => {
		const result = symbolSearchResult([symbol({ name: "add", path: `${ROOT}/a.ts` })], true);
		const normalized = normalizeSymbolSearchResult(result, "add", ROOT, 100);
		expect(normalized.truncated).toBe(true);
	});
});
