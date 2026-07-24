import type { WorkspaceSymbol } from "@danypops/lector";
import { keyHint, type ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * Custom TUI rendering for find_symbols -- the one Lector-backed tool with
 * no built-in pi-coding-agent equivalent to inherit rendering from. read/
 * write/edit get syntax highlighting, diffs, and truncation banners for
 * free via createReadToolDefinition/etc.; this tool needs its own, built
 * the same way pi's own built-ins are (see @earendil-works/pi-coding-agent's
 * read.js/write.js/edit.js and the todo.ts example) -- theme.fg/theme.bold
 * plus keyHint for the expand affordance, not ad-hoc plain text.
 *
 * Depends on the minimal slice of pi-coding-agent's real Theme class this
 * module actually uses, not the full class (15+ methods, private fields) --
 * narrower, and a plain pass-through object satisfies it directly in tests
 * with no cast needed, since Theme's real fg/bold already structurally match.
 */
export interface FindSymbolsTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

const DEFAULT_VISIBLE_RESULTS = 8;

/** Maps a symbol's kind to the closest semantic syntax-highlighting color already in the theme palette, rather than inventing new colors find_symbols alone would use. */
const SYMBOL_KIND_COLOR: Record<string, ThemeColor> = {
	function: "syntaxFunction",
	method: "syntaxFunction",
	class: "syntaxType",
	interface: "syntaxType",
	"type-alias": "syntaxType",
	enum: "syntaxType",
	variable: "syntaxVariable",
};

function colorForKind(kind: string): ThemeColor {
	return SYMBOL_KIND_COLOR[kind] ?? "muted";
}

export function formatFindSymbolsCall(args: { query?: unknown; directory?: unknown }, theme: FindSymbolsTheme): string {
	const query = typeof args.query === "string" ? args.query : "";
	let content = `${theme.fg("toolTitle", theme.bold("find_symbols"))} ${theme.fg("accent", `"${query}"`)}`;
	if (typeof args.directory === "string" && args.directory.length > 0) {
		content += ` ${theme.fg("muted", `in ${args.directory}`)}`;
	}
	return content;
}

/** One result line, kind-padded to the widest kind actually present so the name column lines up. */
function formatSymbolLine(symbol: WorkspaceSymbol, theme: FindSymbolsTheme, kindColumnWidth: number): string {
	const kind = theme.fg(colorForKind(symbol.kind), symbol.kind.padEnd(kindColumnWidth));
	const name = theme.fg("text", theme.bold(symbol.name));
	const location = theme.fg("dim", `${symbol.location.path}:${symbol.location.line}:${symbol.location.character}`);
	return `${kind}  ${name}  ${location}`;
}

export function formatFindSymbolsResult(
	symbols: readonly WorkspaceSymbol[] | undefined,
	query: string,
	expanded: boolean,
	theme: FindSymbolsTheme,
): string {
	if (!symbols || symbols.length === 0) {
		return theme.fg("dim", `No symbols found matching "${query}".`);
	}

	const kindColumnWidth = Math.max(...symbols.map((symbol) => symbol.kind.length));
	const displayCount = expanded ? symbols.length : Math.min(symbols.length, DEFAULT_VISIBLE_RESULTS);
	const lines = [theme.fg("muted", `${symbols.length} symbol${symbols.length === 1 ? "" : "s"} matching "${query}":`)];

	for (const symbol of symbols.slice(0, displayCount)) {
		lines.push(formatSymbolLine(symbol, theme, kindColumnWidth));
	}

	const remaining = symbols.length - displayCount;
	if (remaining > 0) {
		lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	}

	return lines.join("\n");
}
