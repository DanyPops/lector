/**
 * find_symbols is the one Lector-backed tool with no built-in
 * pi-coding-agent equivalent to inherit rendering from (read/write/edit
 * get syntax highlighting, diffs, and truncation banners for free via
 * createReadToolDefinition/etc.). These tests exercise the actual rendered
 * text a user would see, using a plain pass-through fake theme (no ANSI
 * noise) that satisfies FindSymbolsTheme directly -- no cast needed, since
 * it's the same shape the real Theme class's fg/bold already have.
 */
import { describe, expect, it } from "bun:test";
import type { WorkspaceSymbol } from "@danypops/lector";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type FindSymbolsTheme, formatFindSymbolsCall, formatFindSymbolsResult } from "../extension/src/find-symbols-rendering.ts";

// keyHint() (used for the "... N more, press X to expand" truncation notice) reads pi's
// global keybinding-config-backed theme singleton, independent of the FindSymbolsTheme fake
// below (which only stands in for fg/bold) -- it throws "Theme not initialized" without this.
initTheme();

const plainTheme: FindSymbolsTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function symbol(overrides: Partial<WorkspaceSymbol> = {}): WorkspaceSymbol {
	return {
		name: "exactEdit",
		kind: "function",
		location: { path: "src/domain/exact-edit.ts", line: 12, character: 1 },
		...overrides,
	};
}

describe("formatFindSymbolsCall", () => {
	it("shows the tool name and the quoted query", () => {
		const text = formatFindSymbolsCall({ query: "exactEdit" }, plainTheme);
		expect(text).toContain("find_symbols");
		expect(text).toContain('"exactEdit"');
	});

	it("shows the directory when given", () => {
		const text = formatFindSymbolsCall({ query: "exactEdit", directory: "packages/lector" }, plainTheme);
		expect(text).toContain("packages/lector");
	});

	it("does not crash or show 'undefined' while arguments are still streaming in (query missing)", () => {
		const text = formatFindSymbolsCall({}, plainTheme);
		expect(text).not.toContain("undefined");
	});
});

describe("formatFindSymbolsResult", () => {
	it("shows a clear, distinct message when nothing matched -- not blank, not an error", () => {
		const text = formatFindSymbolsResult([], "NoSuchSymbol", false, plainTheme);
		expect(text).toContain("No symbols found");
		expect(text).toContain("NoSuchSymbol");
	});

	it("shows every symbol's kind, name, and location", () => {
		const symbols = [symbol({ name: "exactEdit", kind: "function" }), symbol({ name: "InMemoryWorkspace", kind: "class" })];
		const text = formatFindSymbolsResult(symbols, "e", false, plainTheme);
		expect(text).toContain("function");
		expect(text).toContain("exactEdit");
		expect(text).toContain("class");
		expect(text).toContain("InMemoryWorkspace");
		expect(text).toContain("src/domain/exact-edit.ts:12:1");
	});

	it("truncates to the default visible count when not expanded, and says how many more remain", () => {
		const symbols = Array.from({ length: 12 }, (_, i) => symbol({ name: `symbol${i}` }));
		const text = formatFindSymbolsResult(symbols, "symbol", false, plainTheme);

		expect(text).toContain("symbol0");
		expect(text).not.toContain("symbol11"); // beyond the default visible count
		expect(text).toContain("4 more"); // 12 total, 8 shown by default
	});

	it("shows every result when expanded, with no truncation notice", () => {
		const symbols = Array.from({ length: 12 }, (_, i) => symbol({ name: `symbol${i}` }));
		const text = formatFindSymbolsResult(symbols, "symbol", true, plainTheme);

		expect(text).toContain("symbol0");
		expect(text).toContain("symbol11");
		expect(text).not.toContain("more");
	});

	it("does not show a truncation notice when the result count is already within the default visible count", () => {
		const symbols = [symbol()];
		const text = formatFindSymbolsResult(symbols, "exactEdit", false, plainTheme);
		expect(text).not.toContain("more");
	});
});
