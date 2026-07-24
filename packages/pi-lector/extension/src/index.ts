import { resolve } from "node:path";
import type { CallHierarchyEntry, Diagnostic, DocumentSymbolEntry, Hover, IncomingCall, OutgoingCall, WorkspaceLocation, WorkspaceSymbol } from "@danypops/lector";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createLectorCodeIntelligenceOperations } from "./code-intelligence-operations.ts";
import {
	formatDiagnosticsCall,
	formatDiagnosticsResult,
	formatDocumentSymbolsCall,
	formatDocumentSymbolsResult,
	formatFindReferencesCall,
	formatFindReferencesResult,
	formatGoToDefinitionCall,
	formatGoToDefinitionResult,
	formatHoverCall,
	formatHoverResult,
	formatIncomingCallsCall,
	formatIncomingCallsResult,
	formatOutgoingCallsCall,
	formatOutgoingCallsResult,
	formatPrepareCallHierarchyCall,
	formatPrepareCallHierarchyResult,
} from "./code-intelligence-rendering.ts";
import { createLectorEditOperations } from "./edit-operations.ts";
import { createLectorFindSymbolsOperations } from "./find-symbols-operations.ts";
import { formatFindSymbolsCall, formatFindSymbolsResult } from "./find-symbols-rendering.ts";
import { createLectorReadOperations } from "./read-operations.ts";
import { createLectorWriteOperations } from "./write-operations.ts";

/**
 * pi-lector -- the thin Pi host adapter for Lector. Overrides the built-in
 * read/write/edit tools by name with Lector-backed Operations, so built-in
 * rendering (syntax highlighting, diffs, truncation banners) is kept for
 * free while every actual file operation routes through a running Lector
 * daemon. Adds find_symbols and the code-intelligence tools, which have no
 * built-in pi-coding-agent equivalent.
 *
 * read/write/edit's Lector-backed Operations resolve their own workspace
 * per absolute path touched (workspaceForPath), never from a `cwd`
 * captured once at session start -- `cwd` is still passed to
 * createReadToolDefinition/etc. themselves, but only for their own
 * relative-path display, not for workspace resolution.
 *
 * grep/find/ls are not overridden -- no Lector operation backs them yet.
 * No daemon auto-spawn: a Lector-backed tool call fails with a clear
 * "start it with `lector serve`" error if none is reachable.
 */
export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const { cwd } = ctx;
		pi.registerTool(createReadToolDefinition(cwd, { operations: createLectorReadOperations() }));
		pi.registerTool(createWriteToolDefinition(cwd, { operations: createLectorWriteOperations() }));
		pi.registerTool(createEditToolDefinition(cwd, { operations: createLectorEditOperations() }));

		const findSymbolsOperations = createLectorFindSymbolsOperations();
		pi.registerTool({
			name: "find_symbols",
			label: "Find Symbols",
			description:
				"Search a workspace for functions, classes, interfaces, types, enums, and methods by name " +
				"(case-insensitive substring match). Returns each match's kind and file location. `directory` " +
				"selects which project to search -- pass the current working directory to search it, or any " +
				"other project's directory to get code intelligence there without needing to be in it.",
			promptSnippet: "Search a workspace for a symbol (function, class, etc.) by name",
			promptGuidelines: [
				"Use find_symbols to locate where a function, class, interface, type, enum, or method is declared by name, instead of grepping for it.",
				"find_symbols' directory argument selects which project to search; it is never inferred, so pass the current working directory explicitly to search the current project, or another project's directory to search that one instead.",
			],
			parameters: Type.Object({
				query: Type.String({ description: "Name or substring to search for, case-insensitive" }),
				directory: Type.String({ description: "Directory of the project to search, absolute or relative to the current working directory" }),
			}),
			async execute(_toolCallId, params) {
				const directory = resolve(cwd, params.directory);
				const symbols = await findSymbolsOperations.findSymbols(params.query, directory);
				const text =
					symbols.length === 0
						? `No symbols found matching "${params.query}".`
						: symbols
								.map((symbol) => `${symbol.kind} ${symbol.name} -- ${symbol.location.path}:${symbol.location.line}:${symbol.location.character}`)
								.join("\n");
				return { content: [{ type: "text", text }], details: { symbols } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindSymbolsCall(args as { query?: unknown; directory?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) {
					return new Text(theme.fg("warning", "Searching..."), 0, 0);
				}
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "find_symbols failed"), 0, 0);
				}
				const details = result.details as { symbols?: readonly WorkspaceSymbol[] } | undefined;
				const query = typeof context.args?.query === "string" ? context.args.query : "";
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindSymbolsResult(details?.symbols, query, expanded, theme));
				return text;
			},
		});

		const codeIntelligenceOperations = createLectorCodeIntelligenceOperations();
		const positionParameters = {
			path: Type.String({ description: "Absolute or cwd-relative path to the file" }),
			line: Type.Number({ description: "1-indexed line number" }),
			character: Type.Number({ description: "1-indexed character offset within the line" }),
		};

		pi.registerTool({
			name: "go_to_definition",
			label: "Go to Definition",
			description: "Find where the symbol at an exact file position is actually declared, across files, through re-exports and aliasing.",
			promptSnippet: "Jump to a symbol's real declaration from an exact position",
			promptGuidelines: ["Use go_to_definition with a position from a prior read or find_symbols result, not a symbol name -- position-based, not name-based."],
			parameters: Type.Object(positionParameters),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const locations = await codeIntelligenceOperations.goToDefinition(path, params.line, params.character);
				const text = locations.length === 0 ? "No definition found." : locations.map((l) => `${l.path}:${l.line}:${l.character}`).join("\n");
				return { content: [{ type: "text", text }], details: { locations } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGoToDefinitionCall(args as { path?: unknown; line?: unknown; character?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Looking up definition..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "go_to_definition failed"), 0, 0);
				}
				const details = result.details as { locations?: readonly WorkspaceLocation[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGoToDefinitionResult(details?.locations, expanded, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "find_references",
			label: "Find References",
			description: "Find every project-wide usage of the symbol at an exact file position.",
			promptSnippet: "Find every usage of a symbol from an exact position",
			promptGuidelines: [
				"Use find_references with a position from a prior read or find_symbols result, not a symbol name -- position-based, not name-based.",
				"A file you have already read or queried is guaranteed to have its own usages included; a file never touched this session may be missing until queried once (e.g. via document_symbols).",
			],
			parameters: Type.Object({
				...positionParameters,
				includeDeclaration: Type.Boolean({ description: "Include the declaration site itself among the results" }),
			}),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const locations = await codeIntelligenceOperations.findReferences(path, params.line, params.character, params.includeDeclaration);
				const text = locations.length === 0 ? "No references found." : locations.map((l) => `${l.path}:${l.line}:${l.character}`).join("\n");
				return { content: [{ type: "text", text }], details: { locations } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindReferencesCall(args as { path?: unknown; line?: unknown; character?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Searching for references..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "find_references failed"), 0, 0);
				}
				const details = result.details as { locations?: readonly WorkspaceLocation[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindReferencesResult(details?.locations, expanded, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "hover",
			label: "Hover",
			description: "Get type and documentation information for the symbol at an exact file position.",
			promptSnippet: "Get type/doc info for a symbol from an exact position",
			promptGuidelines: [
				"Use hover with a position from a prior read or find_symbols result to see a symbol's inferred type and JSDoc without opening its declaring file.",
			],
			parameters: Type.Object(positionParameters),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const hover = await codeIntelligenceOperations.hover(path, params.line, params.character);
				return { content: [{ type: "text", text: hover?.contents ?? "No hover information available." }], details: { hover } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatHoverCall(args as { path?: unknown; line?: unknown; character?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Loading hover information..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "hover failed"), 0, 0);
				}
				const details = result.details as { hover?: Hover } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatHoverResult(details?.hover, expanded, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "document_symbols",
			label: "Document Symbols",
			description: "List every symbol declared in one file, hierarchically -- an outline of its classes, functions, and their members.",
			promptSnippet: "Get a hierarchical outline of one file's declarations",
			promptGuidelines: ["Use document_symbols to get a file's outline directly, instead of reading the whole file to find what it declares."],
			parameters: Type.Object({ path: Type.String({ description: "Absolute or cwd-relative path to the file" }) }),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const symbols = await codeIntelligenceOperations.documentSymbols(path);
				const text = symbols.length === 0 ? "No symbols found." : symbols.map((s) => `${s.kind} ${s.name}`).join("\n");
				return { content: [{ type: "text", text }], details: { symbols } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatDocumentSymbolsCall(args as { path?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Loading symbols..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "document_symbols failed"), 0, 0);
				}
				const details = result.details as { symbols?: readonly DocumentSymbolEntry[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatDocumentSymbolsResult(details?.symbols, expanded, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "diagnostics",
			label: "Diagnostics",
			description: "List every error and warning a language server currently knows about for one file, as of its last analysis.",
			promptSnippet: "List current errors/warnings for one file",
			promptGuidelines: ["Use diagnostics after an edit to check for new type errors in one specific file, instead of running a full project build."],
			parameters: Type.Object({ path: Type.String({ description: "Absolute or cwd-relative path to the file" }) }),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const diagnostics = await codeIntelligenceOperations.diagnostics(path);
				const text =
					diagnostics.length === 0
						? "No diagnostics."
						: diagnostics.map((d) => `${d.severity} ${d.range.path}:${d.range.start.line}:${d.range.start.character} -- ${d.message}`).join("\n");
				return { content: [{ type: "text", text }], details: { diagnostics } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatDiagnosticsCall(args as { path?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Checking diagnostics..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "diagnostics failed"), 0, 0);
				}
				const details = result.details as { diagnostics?: readonly Diagnostic[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatDiagnosticsResult(details?.diagnostics, expanded, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "prepare_call_hierarchy",
			label: "Prepare Call Hierarchy",
			description: "Resolve the symbol at an exact file position to its call-hierarchy root -- the first step before incoming_calls or outgoing_calls.",
			promptSnippet: "Resolve a position to a call-hierarchy root",
			promptGuidelines: [
				"Use prepare_call_hierarchy to confirm what a position resolves to before asking for its callers or callees; incoming_calls and outgoing_calls also do this internally, so calling it first is optional, not required.",
			],
			parameters: Type.Object(positionParameters),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const items = await codeIntelligenceOperations.prepareCallHierarchy(path, params.line, params.character);
				const text = items.length === 0 ? "No call-hierarchy root at this position." : items.map((i) => `${i.kind} ${i.name} -- ${i.location.path}:${i.location.line}:${i.location.character}`).join("\n");
				return { content: [{ type: "text", text }], details: { items } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatPrepareCallHierarchyCall(args as { path?: unknown; line?: unknown; character?: unknown }, theme));
				return text;
			},
			renderResult(result, { isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Resolving position..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "prepare_call_hierarchy failed"), 0, 0);
				}
				const details = result.details as { items?: readonly CallHierarchyEntry[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatPrepareCallHierarchyResult(details?.items, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "incoming_calls",
			label: "Incoming Calls",
			description: "Find every real caller of the function/method at an exact file position, project-wide.",
			promptSnippet: "Find every caller of a function from an exact position",
			promptGuidelines: [
				"Use incoming_calls to see who actually calls a function, as distinct from find_references, which also finds non-call usages like type positions or re-exports.",
			],
			parameters: Type.Object(positionParameters),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const calls = await codeIntelligenceOperations.incomingCalls(path, params.line, params.character);
				const text = calls.length === 0 ? "No incoming calls found." : calls.map((c) => `${c.from.kind} ${c.from.name} -- ${c.from.location.path}:${c.from.location.line}:${c.from.location.character}`).join("\n");
				return { content: [{ type: "text", text }], details: { calls } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatIncomingCallsCall(args as { path?: unknown; line?: unknown; character?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Searching for callers..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "incoming_calls failed"), 0, 0);
				}
				const details = result.details as { calls?: readonly IncomingCall[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatIncomingCallsResult(details?.calls, expanded, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "outgoing_calls",
			label: "Outgoing Calls",
			description: "Find every function/method the function at an exact file position itself calls.",
			promptSnippet: "Find every function a function itself calls",
			promptGuidelines: ["Use outgoing_calls to see what a function calls internally, e.g. to trace a code path forward without opening every file by hand."],
			parameters: Type.Object(positionParameters),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const calls = await codeIntelligenceOperations.outgoingCalls(path, params.line, params.character);
				const text = calls.length === 0 ? "No outgoing calls found." : calls.map((c) => `${c.to.kind} ${c.to.name} -- ${c.to.location.path}:${c.to.location.line}:${c.to.location.character}`).join("\n");
				return { content: [{ type: "text", text }], details: { calls } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatOutgoingCallsCall(args as { path?: unknown; line?: unknown; character?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Searching for callees..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "outgoing_calls failed"), 0, 0);
				}
				const details = result.details as { calls?: readonly OutgoingCall[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatOutgoingCallsResult(details?.calls, expanded, theme));
				return text;
			},
		});
	});
}
