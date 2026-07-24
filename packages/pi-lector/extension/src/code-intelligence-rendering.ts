import type { CallHierarchyEntry, Diagnostic, DocumentSymbolEntry, Hover, IncomingCall, OutgoingCall, SymbolNode, WorkspaceLocation } from "@danypops/lector";
import { keyHint, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { colorForKind, formatLocation, type LectorTheme } from "./lector-tui-theme.ts";

/**
 * Custom TUI rendering for the code-intelligence tools: go_to_definition,
 * find_references, hover, document_symbols. None of these have a built-in
 * pi-coding-agent equivalent to inherit
 * rendering from, exactly like find_symbols -- same theme.fg/theme.bold/
 * keyHint approach, sharing find_symbols' own kind-coloring and location
 * formatting via lector-tui-theme.ts rather than redefining it four times.
 */

const DEFAULT_VISIBLE_LOCATIONS = 8;
const DEFAULT_VISIBLE_SYMBOLS = 12;
const DEFAULT_VISIBLE_DIAGNOSTICS = 12;
const DEFAULT_VISIBLE_CALLS = 12;

const DIAGNOSTIC_SEVERITY_COLOR: Record<Diagnostic["severity"], ThemeColor> = {
	error: "error",
	warning: "warning",
	information: "muted",
	hint: "dim",
};

function formatPositionalCall(toolName: string, args: { path?: unknown; line?: unknown; character?: unknown }, theme: LectorTheme): string {
	const path = typeof args.path === "string" ? args.path : "";
	const line = typeof args.line === "number" ? args.line : "?";
	const character = typeof args.character === "number" ? args.character : "?";
	return `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", `${path}:${line}:${character}`)}`;
}

function formatLocationList(locations: readonly WorkspaceLocation[] | undefined, emptyMessage: string, expanded: boolean, theme: LectorTheme): string {
	if (!locations || locations.length === 0) return theme.fg("dim", emptyMessage);

	const displayCount = expanded ? locations.length : Math.min(locations.length, DEFAULT_VISIBLE_LOCATIONS);
	const lines = [theme.fg("muted", `${locations.length} location${locations.length === 1 ? "" : "s"}:`)];
	for (const location of locations.slice(0, displayCount)) {
		lines.push(`  ${formatLocation(theme, location.path, location.line, location.character)}`);
	}
	const remaining = locations.length - displayCount;
	if (remaining > 0) lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	return lines.join("\n");
}

export function formatGoToDefinitionCall(args: { path?: unknown; line?: unknown; character?: unknown }, theme: LectorTheme): string {
	return formatPositionalCall("go_to_definition", args, theme);
}

export function formatGoToDefinitionResult(locations: readonly WorkspaceLocation[] | undefined, expanded: boolean, theme: LectorTheme): string {
	return formatLocationList(locations, "No definition found.", expanded, theme);
}

export function formatGoToImplementationCall(args: { path?: unknown; line?: unknown; character?: unknown }, theme: LectorTheme): string {
	return formatPositionalCall("go_to_implementation", args, theme);
}

export function formatGoToImplementationResult(locations: readonly WorkspaceLocation[] | undefined, expanded: boolean, theme: LectorTheme): string {
	return formatLocationList(locations, "No implementation found.", expanded, theme);
}

export function formatFindReferencesCall(args: { path?: unknown; line?: unknown; character?: unknown }, theme: LectorTheme): string {
	return formatPositionalCall("find_references", args, theme);
}

export function formatFindReferencesResult(locations: readonly WorkspaceLocation[] | undefined, expanded: boolean, theme: LectorTheme): string {
	return formatLocationList(locations, "No references found.", expanded, theme);
}

export function formatHoverCall(args: { path?: unknown; line?: unknown; character?: unknown }, theme: LectorTheme): string {
	return formatPositionalCall("hover", args, theme);
}

const HOVER_COLLAPSED_LINE_COUNT = 6;

export function formatHoverResult(hover: Hover | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!hover) return theme.fg("dim", "No hover information available.");
	const lines = hover.contents.split("\n");
	if (expanded || lines.length <= HOVER_COLLAPSED_LINE_COUNT) return hover.contents;
	const remaining = lines.length - HOVER_COLLAPSED_LINE_COUNT;
	return `${lines.slice(0, HOVER_COLLAPSED_LINE_COUNT).join("\n")}\n${theme.fg("dim", `... ${remaining} more line${remaining === 1 ? "" : "s"} (${keyHint("app.tools.expand", "to expand")})`)}`;
}

export function formatDocumentSymbolsCall(args: { path?: unknown }, theme: LectorTheme): string {
	const path = typeof args.path === "string" ? args.path : "";
	return `${theme.fg("toolTitle", theme.bold("document_symbols"))} ${theme.fg("accent", path)}`;
}

/** Flattens a hierarchical DocumentSymbolEntry[] into (depth, entry) pairs, depth-first, for bounded rendering. */
function flattenSymbols(entries: readonly DocumentSymbolEntry[], depth = 0): Array<{ depth: number; entry: DocumentSymbolEntry }> {
	const flattened: Array<{ depth: number; entry: DocumentSymbolEntry }> = [];
	for (const entry of entries) {
		flattened.push({ depth, entry });
		if (entry.children) flattened.push(...flattenSymbols(entry.children, depth + 1));
	}
	return flattened;
}

export function formatDocumentSymbolsResult(symbols: readonly DocumentSymbolEntry[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!symbols || symbols.length === 0) return theme.fg("dim", "No symbols found.");

	const flattened = flattenSymbols(symbols);
	const kindColumnWidth = Math.max(...flattened.map(({ entry }) => entry.kind.length));
	const displayCount = expanded ? flattened.length : Math.min(flattened.length, DEFAULT_VISIBLE_SYMBOLS);
	const lines = [theme.fg("muted", `${flattened.length} symbol${flattened.length === 1 ? "" : "s"}:`)];

	for (const { depth, entry } of flattened.slice(0, displayCount)) {
		const indent = "  ".repeat(depth + 1);
		const kind = theme.fg(colorForKind(entry.kind), entry.kind.padEnd(kindColumnWidth));
		const name = theme.fg("text", theme.bold(entry.name));
		const location = formatLocation(theme, entry.range.path, entry.selectionRange.start.line, entry.selectionRange.start.character);
		lines.push(`${indent}${kind}  ${name}  ${location}`);
	}

	const remaining = flattened.length - displayCount;
	if (remaining > 0) lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	return lines.join("\n");
}

export function formatDiagnosticsCall(args: { path?: unknown }, theme: LectorTheme): string {
	const path = typeof args.path === "string" ? args.path : "";
	return `${theme.fg("toolTitle", theme.bold("diagnostics"))} ${theme.fg("accent", path)}`;
}

export function formatDiagnosticsResult(diagnostics: readonly Diagnostic[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!diagnostics || diagnostics.length === 0) return theme.fg("success", "No diagnostics.");

	const displayCount = expanded ? diagnostics.length : Math.min(diagnostics.length, DEFAULT_VISIBLE_DIAGNOSTICS);
	const lines = [theme.fg("muted", `${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}:`)];

	for (const diagnostic of diagnostics.slice(0, displayCount)) {
		const severity = theme.fg(DIAGNOSTIC_SEVERITY_COLOR[diagnostic.severity] ?? "muted", theme.bold(diagnostic.severity));
		const location = formatLocation(theme, diagnostic.range.path, diagnostic.range.start.line, diagnostic.range.start.character);
		const origin = diagnostic.source ? theme.fg("dim", ` (${diagnostic.source}${diagnostic.code !== undefined ? ` ${diagnostic.code}` : ""})`) : "";
		lines.push(`  ${severity} ${location} -- ${diagnostic.message}${origin}`);
	}

	const remaining = diagnostics.length - displayCount;
	if (remaining > 0) lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	return lines.join("\n");
}

function formatCallHierarchyEntry(entry: { kind: string; name: string; location: WorkspaceLocation }, theme: LectorTheme): string {
	const kind = theme.fg(colorForKind(entry.kind), entry.kind);
	const name = theme.fg("text", theme.bold(entry.name));
	const location = formatLocation(theme, entry.location.path, entry.location.line, entry.location.character);
	return `${kind} ${name} -- ${location}`;
}

export function formatPrepareCallHierarchyCall(args: { path?: unknown; line?: unknown; character?: unknown }, theme: LectorTheme): string {
	return formatPositionalCall("prepare_call_hierarchy", args, theme);
}

export function formatPrepareCallHierarchyResult(items: readonly CallHierarchyEntry[] | undefined, theme: LectorTheme): string {
	if (!items || items.length === 0) return theme.fg("dim", "No call-hierarchy root at this position.");
	return items.map((item) => formatCallHierarchyEntry(item, theme)).join("\n");
}

export function formatIncomingCallsCall(args: { path?: unknown; line?: unknown; character?: unknown }, theme: LectorTheme): string {
	return formatPositionalCall("incoming_calls", args, theme);
}

export function formatIncomingCallsResult(calls: readonly IncomingCall[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!calls || calls.length === 0) return theme.fg("dim", "No incoming calls found.");

	const displayCount = expanded ? calls.length : Math.min(calls.length, DEFAULT_VISIBLE_CALLS);
	const lines = [theme.fg("muted", `${calls.length} caller${calls.length === 1 ? "" : "s"}:`)];
	for (const call of calls.slice(0, displayCount)) lines.push(`  ${formatCallHierarchyEntry(call.from, theme)}`);

	const remaining = calls.length - displayCount;
	if (remaining > 0) lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	return lines.join("\n");
}

export function formatOutgoingCallsCall(args: { path?: unknown; line?: unknown; character?: unknown }, theme: LectorTheme): string {
	return formatPositionalCall("outgoing_calls", args, theme);
}

export function formatOutgoingCallsResult(calls: readonly OutgoingCall[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!calls || calls.length === 0) return theme.fg("dim", "No outgoing calls found.");

	const displayCount = expanded ? calls.length : Math.min(calls.length, DEFAULT_VISIBLE_CALLS);
	const lines = [theme.fg("muted", `${calls.length} callee${calls.length === 1 ? "" : "s"}:`)];
	for (const call of calls.slice(0, displayCount)) lines.push(`  ${formatCallHierarchyEntry(call.to, theme)}`);

	const remaining = calls.length - displayCount;
	if (remaining > 0) lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	return lines.join("\n");
}

export function formatPopulateSymbolGraphCall(args: { path?: unknown; maxFiles?: unknown; maxSymbolsPerFile?: unknown }, theme: LectorTheme): string {
	const path = typeof args.path === "string" ? args.path : "";
	return `${theme.fg("toolTitle", theme.bold("populate_symbol_graph"))} ${theme.fg("accent", path)}`;
}

export function formatPopulateSymbolGraphResult(
	result: { filesProcessed: number; symbolsProcessed: number; nodesAdded: number; edgesAdded: number } | undefined,
	theme: LectorTheme,
): string {
	if (!result) return theme.fg("dim", "No result.");
	return theme.fg(
		"muted",
		`${result.filesProcessed} file${result.filesProcessed === 1 ? "" : "s"}, ${result.symbolsProcessed} symbol${result.symbolsProcessed === 1 ? "" : "s"}, ${result.nodesAdded} node${result.nodesAdded === 1 ? "" : "s"}, ${result.edgesAdded} edge${result.edgesAdded === 1 ? "" : "s"}`,
	);
}

export function formatReachableFromCall(args: { path?: unknown; line?: unknown; character?: unknown; maxDepth?: unknown }, theme: LectorTheme): string {
	const base = formatPositionalCall("reachable_from", args, theme);
	const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : "?";
	return `${base} ${theme.fg("dim", `(depth ${maxDepth})`)}`;
}

export function formatReachableFromResult(symbols: readonly SymbolNode[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!symbols || symbols.length === 0) return theme.fg("dim", "Nothing reachable at this position (has the graph been populated for this workspace?).");

	const displayCount = expanded ? symbols.length : Math.min(symbols.length, DEFAULT_VISIBLE_CALLS);
	const lines = [theme.fg("muted", `${symbols.length} reachable symbol${symbols.length === 1 ? "" : "s"}:`)];
	for (const symbol of symbols.slice(0, displayCount)) lines.push(`  ${formatCallHierarchyEntry(symbol, theme)}`);

	const remaining = symbols.length - displayCount;
	if (remaining > 0) lines.push(theme.fg("dim", `... ${remaining} more (${keyHint("app.tools.expand", "to expand")})`));
	return lines.join("\n");
}
