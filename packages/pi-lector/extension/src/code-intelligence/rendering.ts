import type {
	CallHierarchyEntry,
	Diagnostic,
	DocumentSymbolEntry,
	Hover,
	IncomingCall,
	IntelligenceProvenance,
	OperationOutputs,
	OutgoingCall,
	SymbolNode,
	WorkspaceLocation,
	WorkspaceMapResult,
} from "@danypops/lector";
import { keyHint, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { renderTruncatedList } from "malevich-tui-components";
import { colorForKind, formatLocation, type LectorTheme } from "../lector-tui-theme.ts";
import { presentationTitle } from "../presentation/tool-presentation.ts";

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
const DEFAULT_VISIBLE_CHANGES = 12;

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
	return `${theme.fg("toolTitle", theme.bold(presentationTitle(toolName)))} ${theme.fg("accent", `${path}:${line}:${character}`)}`;
}

function moreLine(theme: LectorTheme): (hidden: number) => string {
	return (hidden) => theme.fg("dim", `... ${hidden} more (${keyHint("app.tools.expand", "to expand")})`);
}

function formatLocationList(locations: readonly WorkspaceLocation[] | undefined, emptyMessage: string, expanded: boolean, theme: LectorTheme): string {
	if (!locations || locations.length === 0) return theme.fg("dim", emptyMessage);

	const lines = [
		theme.fg("muted", `${locations.length} location${locations.length === 1 ? "" : "s"}:`),
		...renderTruncatedList({
			items: locations,
			expanded,
			visibleCount: DEFAULT_VISIBLE_LOCATIONS,
			formatItem: (location) => `  ${formatLocation(theme, location.path, location.line, location.character)}`,
			moreLine: moreLine(theme),
		}),
	];
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
	const body = renderTruncatedList({
		items: lines,
		expanded: false,
		visibleCount: HOVER_COLLAPSED_LINE_COUNT,
		formatItem: (line) => line,
		moreLine: (hidden) => theme.fg("dim", `... ${hidden} more line${hidden === 1 ? "" : "s"} (${keyHint("app.tools.expand", "to expand")})`),
	});
	return body.join("\n");
}

export function formatDocumentSymbolsCall(args: { path?: unknown }, theme: LectorTheme): string {
	const path = typeof args.path === "string" ? args.path : "";
	return `${theme.fg("toolTitle", theme.bold(presentationTitle("document_symbols")))} ${theme.fg("accent", path)}`;
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
	const lines = [
		theme.fg("muted", `${flattened.length} symbol${flattened.length === 1 ? "" : "s"}:`),
		...renderTruncatedList({
			items: flattened,
			expanded,
			visibleCount: DEFAULT_VISIBLE_SYMBOLS,
			formatItem: ({ depth, entry }) => {
				const indent = "  ".repeat(depth + 1);
				const kind = theme.fg(colorForKind(entry.kind), entry.kind.padEnd(kindColumnWidth));
				const name = theme.fg("text", theme.bold(entry.name));
				const location = formatLocation(theme, entry.range.path, entry.selectionRange.start.line, entry.selectionRange.start.character);
				return `${indent}${kind}  ${name}  ${location}`;
			},
			moreLine: moreLine(theme),
		}),
	];
	return lines.join("\n");
}

export function formatDiagnosticsCall(args: { path?: unknown }, theme: LectorTheme): string {
	const path = typeof args.path === "string" ? args.path : "";
	return `${theme.fg("toolTitle", theme.bold(presentationTitle("diagnostics")))} ${theme.fg("accent", path)}`;
}

export function formatDiagnosticsResult(diagnostics: readonly Diagnostic[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!diagnostics || diagnostics.length === 0) return theme.fg("success", "No diagnostics.");

	const lines = [
		theme.fg("muted", `${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}:`),
		...renderTruncatedList({
			items: diagnostics,
			expanded,
			visibleCount: DEFAULT_VISIBLE_DIAGNOSTICS,
			formatItem: (diagnostic) => {
				const severity = theme.fg(DIAGNOSTIC_SEVERITY_COLOR[diagnostic.severity], theme.bold(diagnostic.severity));
				const location = formatLocation(theme, diagnostic.range.path, diagnostic.range.start.line, diagnostic.range.start.character);
				const origin = diagnostic.source ? theme.fg("dim", ` (${diagnostic.source}${diagnostic.code !== undefined ? ` ${diagnostic.code}` : ""})`) : "";
				return `  ${severity} ${location} -- ${diagnostic.message}${origin}`;
			},
			moreLine: moreLine(theme),
		}),
	];
	return lines.join("\n");
}

function formatPathCall(toolName: string, args: { path?: unknown }, theme: LectorTheme, qualifier = ""): string {
	const path = typeof args.path === "string" ? args.path : "";
	return `${theme.fg("toolTitle", theme.bold(presentationTitle(toolName)))}${qualifier ? ` ${theme.fg("muted", qualifier)}` : ""} ${theme.fg("accent", path)}`;
}

export function formatCodeActionPreviewCall(
	args: { path?: unknown; startLine?: unknown; startCharacter?: unknown; endLine?: unknown; endCharacter?: unknown },
	theme: LectorTheme,
): string {
	const range = `${typeof args.startLine === "number" ? args.startLine : "?"}:${typeof args.startCharacter === "number" ? args.startCharacter : "?"}-${typeof args.endLine === "number" ? args.endLine : "?"}:${typeof args.endCharacter === "number" ? args.endCharacter : "?"}`;
	return formatPathCall("code_action_preview", args, theme, range);
}

export function formatCodeActionPreviewResult(
	result: OperationOutputs["workspace.previewCodeActions"] | undefined,
	expanded: boolean,
	theme: LectorTheme,
): string {
	if (!result || result.actions.length === 0) return theme.fg("dim", "No code actions.");
	return [
		theme.fg("muted", `${result.actions.length} code action${result.actions.length === 1 ? "" : "s"}:`),
		...renderTruncatedList({
			items: result.actions,
			expanded,
			visibleCount: DEFAULT_VISIBLE_CHANGES,
			formatItem: (action) => {
				const state = action.disabledReason
					? theme.fg("warning", `disabled: ${action.disabledReason}`)
					: action.preferred
						? theme.fg("success", "preferred")
						: "";
				const paths = action.affectedPaths.length > 0 ? action.affectedPaths.join(", ") : "command only";
				return `  ${theme.bold(action.title)}${action.kind ? ` (${action.kind})` : ""} -- ${paths}${state ? ` -- ${state}` : ""}`;
			},
			moreLine: moreLine(theme),
			truncationWarning: result.truncated || result.deadlineReached ? theme.fg("warning", "results truncated by the requested bounds") : undefined,
		}),
	].join("\n");
}

export function formatCodeActionApplyCall(args: { path?: unknown }, theme: LectorTheme): string {
	return formatPathCall("code_action_apply", args, theme);
}

export function formatCodeActionApplyResult(result: OperationOutputs["workspace.applyCodeAction"] | undefined, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No code-action result.");
	const lines = result.touchedPaths.map((path) => `  ${path}`);
	if (result.transactionId) lines.push(theme.fg("muted", `transaction ${result.transactionId}`));
	if (result.pendingCommand) lines.push(theme.fg("warning", `pending command ${result.pendingCommand.command}`));
	return lines.length > 0 ? lines.join("\n") : theme.fg("dim", "Code action made no file changes.");
}

export function formatDiagnosticDeltaCall(args: { path?: unknown; source?: unknown }, theme: LectorTheme): string {
	return formatPathCall("diagnostic_delta", args, theme, typeof args.source === "string" ? args.source : "");
}

export function formatDiagnosticDeltaResult(result: OperationOutputs["workspace.diagnosticDelta"] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No diagnostic delta.");
	const changes = [
		...result.introduced.map((diagnostic) => ({ label: "introduced", diagnostic })),
		...result.resolved.map((diagnostic) => ({ label: "resolved", diagnostic })),
		...result.changed.map(({ after }) => ({ label: "changed", diagnostic: after })),
	];
	if (changes.length === 0) return theme.fg("success", "No diagnostic changes.");
	return renderTruncatedList({
		items: changes,
		expanded,
		visibleCount: DEFAULT_VISIBLE_CHANGES,
		formatItem: ({ label, diagnostic }) =>
			`${theme.fg(label === "introduced" ? "error" : label === "resolved" ? "success" : "warning", label)} ${formatLocation(theme, diagnostic.range.path, diagnostic.range.start.line, diagnostic.range.start.character)} -- ${diagnostic.message}`,
		moreLine: moreLine(theme),
		truncationWarning: result.truncated ? theme.fg("warning", "results truncated by maxResults/maxBytes") : undefined,
	}).join("\n");
}

export function formatTypeHierarchyCall(args: { direction?: unknown; path?: unknown; line?: unknown; character?: unknown }, theme: LectorTheme): string {
	const direction = typeof args.direction === "string" ? args.direction : undefined;
	const path = typeof args.path === "string" ? args.path : "";
	const line = typeof args.line === "number" ? args.line : "?";
	const character = typeof args.character === "number" ? args.character : "?";
	return `${theme.fg("toolTitle", theme.bold(presentationTitle("type_hierarchy", direction)))} ${theme.fg("accent", `${path}:${line}:${character}`)}`;
}

export function formatTypeHierarchyResult(
	result: OperationOutputs["workspace.prepareTypeHierarchy"] | undefined,
	expanded: boolean,
	theme: LectorTheme,
): string {
	if (!result || result.items.length === 0) return theme.fg("dim", "No type-hierarchy items found.");
	return renderTruncatedList({
		items: result.items,
		expanded,
		visibleCount: DEFAULT_VISIBLE_CALLS,
		formatItem: (item) => `  ${formatCallHierarchyEntry(item, theme)}${item.detail ? theme.fg("dim", ` -- ${item.detail}`) : ""}`,
		moreLine: moreLine(theme),
		truncationWarning: result.truncated ? theme.fg("warning", "results truncated by the requested bounds") : undefined,
	}).join("\n");
}

export function formatImpactAnalysisCall(args: { path?: unknown; source?: unknown }, theme: LectorTheme): string {
	return formatPathCall("impact_analysis", args, theme, typeof args.source === "string" ? args.source : "");
}

export function formatImpactAnalysisResult(result: OperationOutputs["workspace.impactAnalysis"] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result) return theme.fg("dim", "No impact-analysis result.");
	const impacts = [
		...result.changedSymbols.map(({ symbol, side }) => ({ label: `changed ${side}`, symbol })),
		...result.impactedSymbols.map(({ symbol, depth }) => ({ label: `impact depth=${depth}`, symbol })),
		...result.relatedTests.map(({ symbol, evidence }) => ({ label: `test ${evidence.kind}`, symbol })),
	];
	if (impacts.length === 0) return theme.fg("dim", "No changed symbols resolved.");
	return renderTruncatedList({
		items: impacts,
		expanded,
		visibleCount: DEFAULT_VISIBLE_CHANGES,
		formatItem: ({ label, symbol }) => `${theme.fg("muted", label)} ${formatCallHierarchyEntry(symbol, theme)}`,
		moreLine: moreLine(theme),
		truncationWarning: result.truncated || result.deadlineReached ? theme.fg("warning", "analysis truncated by the requested bounds") : undefined,
	}).join("\n");
}

function formatCallHierarchyEntry(entry: { kind: string; name: string; location: WorkspaceLocation }, theme: LectorTheme): string {
	const kind = theme.fg(colorForKind(entry.kind), entry.kind);
	const name = theme.fg("text", theme.bold(entry.name));
	const location = formatLocation(theme, entry.location.path, entry.location.line, entry.location.character);
	return `${kind} ${name} -- ${location}`;
}

export type CallHierarchyDirection = "prepare" | "incoming" | "outgoing";

// A real discriminated union, not one shape with optional fields -- lets formatCallHierarchyResult
// narrow `items`/`calls` per branch without an unsafe assertion.
export type CallHierarchyToolDetails =
	| { readonly direction: "prepare"; readonly items: readonly CallHierarchyEntry[]; readonly provenance?: IntelligenceProvenance }
	| { readonly direction: "incoming"; readonly calls: readonly IncomingCall[]; readonly provenance?: IntelligenceProvenance }
	| { readonly direction: "outgoing"; readonly calls: readonly OutgoingCall[]; readonly provenance?: IntelligenceProvenance };

export function formatCallHierarchyCall(args: { direction?: unknown; path?: unknown; line?: unknown; character?: unknown }, theme: LectorTheme): string {
	const direction = typeof args.direction === "string" ? args.direction : "";
	const path = typeof args.path === "string" ? args.path : "";
	const line = typeof args.line === "number" ? args.line : "?";
	const character = typeof args.character === "number" ? args.character : "?";
	return `${theme.fg("toolTitle", theme.bold(presentationTitle("call_hierarchy", direction)))} ${theme.fg("accent", `${path}:${line}:${character}`)}`;
}

function formatPrepareCallHierarchyResult(items: readonly CallHierarchyEntry[] | undefined, theme: LectorTheme): string {
	if (!items || items.length === 0) return theme.fg("dim", "No call-hierarchy root at this position.");
	return items.map((item) => formatCallHierarchyEntry(item, theme)).join("\n");
}

function formatIncomingCallsResult(calls: readonly IncomingCall[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!calls || calls.length === 0) return theme.fg("dim", "No incoming calls found.");

	const lines = [
		theme.fg("muted", `${calls.length} caller${calls.length === 1 ? "" : "s"}:`),
		...renderTruncatedList({
			items: calls,
			expanded,
			visibleCount: DEFAULT_VISIBLE_CALLS,
			formatItem: (call) => `  ${formatCallHierarchyEntry(call.from, theme)}`,
			moreLine: moreLine(theme),
		}),
	];
	return lines.join("\n");
}

function formatOutgoingCallsResult(calls: readonly OutgoingCall[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!calls || calls.length === 0) return theme.fg("dim", "No outgoing calls found.");

	const lines = [
		theme.fg("muted", `${calls.length} callee${calls.length === 1 ? "" : "s"}:`),
		...renderTruncatedList({
			items: calls,
			expanded,
			visibleCount: DEFAULT_VISIBLE_CALLS,
			formatItem: (call) => `  ${formatCallHierarchyEntry(call.to, theme)}`,
			moreLine: moreLine(theme),
		}),
	];
	return lines.join("\n");
}

export function formatCallHierarchyResult(details: CallHierarchyToolDetails | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!details) return theme.fg("dim", "No result.");
	if (details.direction === "prepare") return formatPrepareCallHierarchyResult(details.items, theme);
	if (details.direction === "incoming") return formatIncomingCallsResult(details.calls, expanded, theme);
	return formatOutgoingCallsResult(details.calls, expanded, theme);
}

export function formatReachableFromCall(args: { path?: unknown; line?: unknown; character?: unknown; maxDepth?: unknown }, theme: LectorTheme): string {
	const base = formatPositionalCall("reachable_from", args, theme);
	const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : "?";
	return `${base} ${theme.fg("dim", `(depth ${maxDepth})`)}`;
}

export function formatReachableFromResult(symbols: readonly SymbolNode[] | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!symbols || symbols.length === 0)
		return theme.fg("dim", "Nothing reachable at this position (the workspace's symbol graph may still be populating in the background -- retry shortly).");

	const lines = [
		theme.fg("muted", `${symbols.length} reachable symbol${symbols.length === 1 ? "" : "s"}:`),
		...renderTruncatedList({
			items: symbols,
			expanded,
			visibleCount: DEFAULT_VISIBLE_CALLS,
			formatItem: (symbol) => `  ${formatCallHierarchyEntry(symbol, theme)}`,
			moreLine: moreLine(theme),
		}),
	];
	return lines.join("\n");
}

export function formatWorkspaceMapCall(args: { path?: unknown; maxEntries?: unknown }, theme: LectorTheme): string {
	const path = typeof args.path === "string" ? args.path : "";
	const maxEntries = typeof args.maxEntries === "number" ? ` (top ${args.maxEntries})` : "";
	return `${theme.fg("toolTitle", theme.bold(presentationTitle("workspace_map")))} ${theme.fg("dim", path)}${theme.fg("muted", maxEntries)}`;
}

export function formatWorkspaceMapResult(result: WorkspaceMapResult | undefined, expanded: boolean, theme: LectorTheme): string {
	if (!result || result.entries.length === 0)
		return theme.fg("dim", "No ranked symbols (the workspace's symbol graph may still be populating in the background -- retry shortly).");

	const lines = [
		theme.fg(
			"muted",
			`${result.entries.length} of ${result.totalRanked} ranked symbol${result.totalRanked === 1 ? "" : "s"}, most structurally central first:`,
		),
		...renderTruncatedList({
			items: result.entries,
			expanded,
			visibleCount: DEFAULT_VISIBLE_SYMBOLS,
			formatItem: (entry) => {
				const signature = entry.signature ? ` -- ${entry.signature}` : "";
				return `  ${theme.fg(colorForKind(entry.kind), entry.kind)} ${theme.bold(entry.name)}  ${formatLocation(theme, entry.path, entry.line, entry.character)}${signature}`;
			},
			moreLine: moreLine(theme),
			truncationWarning: result.truncated ? theme.fg("warning", "budget-truncated -- raise --max-entries/--max-bytes for more") : undefined,
		}),
	];
	return lines.join("\n");
}
