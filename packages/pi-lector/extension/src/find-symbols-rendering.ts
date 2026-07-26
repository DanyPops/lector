import type { SymbolSearchResult, WorkspaceSymbol } from "@danypops/lector";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { colorForKind, formatLocation, type LectorTheme } from "./lector-tui-theme.ts";

/**
 * Custom TUI rendering for find_symbols -- the one Lector-backed tool with
 * no built-in pi-coding-agent equivalent to inherit rendering from. read/
 * write/edit get syntax highlighting, diffs, and truncation banners for
 * free via createReadToolDefinition/etc.; this tool needs its own, built
 * the same way pi's own built-ins are (see @earendil-works/pi-coding-agent's
 * read.js/write.js/edit.js and the todo.ts example) -- theme.fg/theme.bold
 * plus keyHint for the expand affordance, not ad-hoc plain text.
 */
export type FindSymbolsTheme = LectorTheme;

const DEFAULT_VISIBLE_RESULTS = 8;

export function formatFindSymbolsCall(args: { query?: unknown; directory?: unknown }, theme: FindSymbolsTheme): string {
	const query = typeof args.query === "string" ? args.query : "";
	let content = `${theme.fg("toolTitle", theme.bold("find_symbols"))} ${theme.fg("accent", `"${query}"`)}`;
	if (typeof args.directory === "string" && args.directory.length > 0) {
		content += ` ${theme.fg("muted", `in ${args.directory}`)}`;
	}
	return content;
}

export function describeFindSymbolSources(result: SymbolSearchResult): readonly string[] {
	return (result.sources ?? []).map((source) => {
		const identity = `${source.provenance.languageId}: ${source.status} via ${source.provenance.backend}`;
		if (source.status === "failed") {
			return source.error ? `${identity} [${source.error.code}] ${source.error.message}` : identity;
		}
		return `${identity} (${source.symbolCount} symbol${source.symbolCount === 1 ? "" : "s"}${source.truncated ? ", truncated" : ""})`;
	});
}

/** One result line, kind-padded to the widest kind actually present so the name column lines up. */
function formatSymbolLine(symbol: WorkspaceSymbol, theme: FindSymbolsTheme, kindColumnWidth: number): string {
	const kind = theme.fg(colorForKind(symbol.kind), symbol.kind.padEnd(kindColumnWidth));
	const name = theme.fg("text", theme.bold(symbol.name));
	const location = formatLocation(theme, symbol.location.path, symbol.location.line, symbol.location.character);
	return `${kind}  ${name}  ${location}`;
}

export function formatFindSymbolsResult(result: SymbolSearchResult | undefined, query: string, expanded: boolean, theme: FindSymbolsTheme): string {
	if (!result) return theme.fg("dim", `No symbols found matching "${query}".`);
	const { symbols, provenance, truncated } = result;
	const source = `${provenance.fidelity} via ${provenance.backend}${truncated ? " (truncated)" : ""}`;
	const sourceLines = describeFindSymbolSources(result).map((line) => theme.fg("muted", line));
	if (symbols.length === 0) {
		return [theme.fg("muted", source), ...sourceLines, theme.fg("dim", `No symbols found matching "${query}".`)].join("\n");
	}

	const kindColumnWidth = Math.max(...symbols.map((symbol) => symbol.kind.length));
	const displayCount = expanded ? symbols.length : Math.min(symbols.length, DEFAULT_VISIBLE_RESULTS);
	const lines = [
		theme.fg("muted", source),
		...sourceLines,
		theme.fg("muted", `${symbols.length} symbol${symbols.length === 1 ? "" : "s"} matching "${query}":`),
	];

	for (const symbol of symbols.slice(0, displayCount)) {
		lines.push(formatSymbolLine(symbol, theme, kindColumnWidth));
	}

	const remaining = symbols.length - displayCount;
	if (remaining > 0) {
		lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	}

	return lines.join("\n");
}
