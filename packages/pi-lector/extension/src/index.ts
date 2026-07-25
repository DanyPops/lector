import { resolve } from "node:path";
import type {
	CallHierarchyEntry,
	Diagnostic,
	DocumentSymbolEntry,
	GitDiffResult,
	GitLogEntry,
	GitStatusSummary,
	Hover,
	IncomingCall,
	JobSnapshot,
	OutgoingCall,
	PopulateSymbolGraphResult,
	RepoFetchResult,
	SymbolNode,
	TextSearchResult,
	WorkspaceLocation,
	WorkspaceQueryOutcome,
	WorkspaceSymbol,
} from "@danypops/lector";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createLectorCodeIntelligenceOperations } from "./code-intelligence-operations.ts";
import {
	describePopulateSymbolGraphJob,
	formatDiagnosticsCall,
	formatDiagnosticsResult,
	formatDocumentSymbolsCall,
	formatDocumentSymbolsResult,
	formatFindReferencesCall,
	formatFindReferencesResult,
	formatGoToDefinitionCall,
	formatGoToDefinitionResult,
	formatGoToImplementationCall,
	formatGoToImplementationResult,
	formatHoverCall,
	formatHoverResult,
	formatIncomingCallsCall,
	formatIncomingCallsResult,
	formatOutgoingCallsCall,
	formatOutgoingCallsResult,
	formatPopulateSymbolGraphCall,
	formatPopulateSymbolGraphResult,
	formatPrepareCallHierarchyCall,
	formatPrepareCallHierarchyResult,
	formatReachableFromCall,
	formatReachableFromResult,
} from "./code-intelligence-rendering.ts";
import { createLectorCrossWorkspaceSearchOperations } from "./cross-workspace-search-operations.ts";
import { formatCrossWorkspaceCall, formatFindSymbolsAcrossProjectsResult, formatSearchTextAcrossProjectsResult } from "./cross-workspace-search-rendering.ts";
import { createLectorEditOperations } from "./edit-operations.ts";
import { createLectorFindSymbolsOperations } from "./find-symbols-operations.ts";
import { formatFindSymbolsCall, formatFindSymbolsResult } from "./find-symbols-rendering.ts";
import { createLectorGitOperations } from "./git-operations.ts";
import { formatGitDiffCall, formatGitDiffResult, formatGitLogCall, formatGitLogResult, formatGitStatusCall, formatGitStatusResult } from "./git-rendering.ts";
import { createLectorReadOperations } from "./read-operations.ts";
import { createLectorRepoFetchOperations } from "./repo-fetch-operations.ts";
import { formatRepoFetchCall, formatRepoFetchResult } from "./repo-fetch-rendering.ts";
import { createLectorSearchOperations } from "./search-operations.ts";
import { formatSearchCall, formatSearchResult } from "./search-rendering.ts";
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
			name: "go_to_implementation",
			label: "Go to Implementation",
			description:
				"Find every concrete implementation of the interface/abstract member at an exact file position -- crosses a port/interface boundary that go_to_definition cannot, since that resolves statically to the interface declaration itself.",
			promptSnippet: "Jump from an interface/port member to its concrete implementation(s)",
			promptGuidelines: [
				"Use go_to_implementation, not go_to_definition, when the position is an interface or abstract member and you need the concrete adapter's real code, not the interface declaration.",
			],
			parameters: Type.Object(positionParameters),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const locations = await codeIntelligenceOperations.goToImplementation(path, params.line, params.character);
				const text = locations.length === 0 ? "No implementation found." : locations.map((l) => `${l.path}:${l.line}:${l.character}`).join("\n");
				return { content: [{ type: "text", text }], details: { locations } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGoToImplementationCall(args as { path?: unknown; line?: unknown; character?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Looking up implementations..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "go_to_implementation failed"), 0, 0);
				}
				const details = result.details as { locations?: readonly WorkspaceLocation[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGoToImplementationResult(details?.locations, expanded, theme));
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
				const text =
					items.length === 0
						? "No call-hierarchy root at this position."
						: items.map((i) => `${i.kind} ${i.name} -- ${i.location.path}:${i.location.line}:${i.location.character}`).join("\n");
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
				const text =
					calls.length === 0
						? "No incoming calls found."
						: calls.map((c) => `${c.from.kind} ${c.from.name} -- ${c.from.location.path}:${c.from.location.line}:${c.from.location.character}`).join("\n");
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
				const text =
					calls.length === 0
						? "No outgoing calls found."
						: calls.map((c) => `${c.to.kind} ${c.to.name} -- ${c.to.location.path}:${c.to.location.line}:${c.to.location.character}`).join("\n");
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

		pi.registerTool({
			name: "populate_symbol_graph",
			label: "Populate Symbol Graph",
			description:
				"Walk a workspace's real call relationships into a persisted graph, so reachable_from can answer multi-hop questions (transitive callers, reachability) without chaining many find_references/outgoing_calls calls by hand. Run this once before reachable_from.",
			promptSnippet: "Populate a workspace's symbol graph for multi-hop queries",
			promptGuidelines: [
				"Run populate_symbol_graph once for a workspace before using reachable_from against it; an unpopulated workspace's graph is empty, not an error.",
				"populate_symbol_graph waits briefly, then returns a job id with an explicit still-loading state instead of blocking the turn. Use job_status later; do not spin in a blind polling loop.",
				"maxFiles and maxSymbolsPerFile are both required and bound the scan explicitly -- a symbol-dense file (many interfaces/properties) can easily exceed a small maxSymbolsPerFile before reaching the functions/methods that actually matter.",
			],
			parameters: Type.Object({
				path: Type.String({ description: "Any absolute or cwd-relative path inside the workspace to populate" }),
				maxFiles: Type.Number({ description: "Maximum number of source files to scan" }),
				maxSymbolsPerFile: Type.Number({ description: "Maximum number of declarations to process per file" }),
				initialWaitMs: Type.Optional(Type.Number({ description: "Bounded initial wait before returning a still-loading job; defaults to 500, maximum 30000" })),
			}),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const job = await codeIntelligenceOperations.populateSymbolGraph(path, params.maxFiles, params.maxSymbolsPerFile, params.initialWaitMs);
				return {
					content: [{ type: "text", text: describePopulateSymbolGraphJob(job) }],
					details: { job },
				};
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatPopulateSymbolGraphCall(args as { path?: unknown; maxFiles?: unknown; maxSymbolsPerFile?: unknown }, theme));
				return text;
			},
			renderResult(result, { isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Populating symbol graph..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "populate_symbol_graph failed"), 0, 0);
				}
				const details = result.details as { job?: JobSnapshot<PopulateSymbolGraphResult> } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatPopulateSymbolGraphResult(details?.job, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "job_status",
			label: "Job Status",
			description:
				"Poll one process-lifetime Lector background job. Returns queued/running with an actionable still-loading state, succeeded with the bounded result, or failed with a stable error code and message. Jobs are bounded and do not survive daemon restart; an unknown id explains expiry/restart rather than returning empty data.",
			promptSnippet: "Poll a Lector background job by id",
			parameters: Type.Object({
				jobId: Type.String({ description: "Job id returned by populate_symbol_graph" }),
			}),
			async execute(_toolCallId, params) {
				const job = await codeIntelligenceOperations.jobStatus(params.jobId);
				return { content: [{ type: "text", text: describePopulateSymbolGraphJob(job) }], details: { job } };
			},
			renderCall(args, theme, context) {
				const jobId = typeof args.jobId === "string" ? args.jobId : "";
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(`${theme.fg("toolTitle", theme.bold("job_status"))} ${theme.fg("accent", jobId)}`);
				return text;
			},
			renderResult(result, { isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Checking background job..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "job_status failed"), 0, 0);
				}
				const details = result.details as { job?: JobSnapshot<PopulateSymbolGraphResult> } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatPopulateSymbolGraphResult(details?.job, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "reachable_from",
			label: "Reachable From",
			description:
				"Every symbol reachable from an exact file position by following the workspace's persisted call graph up to maxDepth hops -- transitive callers/reachability that would otherwise require chaining many find_references/outgoing_calls calls by hand. Requires populate_symbol_graph to have been run for this workspace first.",
			promptSnippet: "Find symbols reachable from a position, up to N hops, via the persisted graph",
			promptGuidelines: [
				"Use reachable_from for multi-hop questions (does A eventually call C through B); use outgoing_calls/incoming_calls for a single direct hop live against the language server.",
			],
			parameters: Type.Object({
				...positionParameters,
				maxDepth: Type.Number({ description: "Maximum number of hops to traverse" }),
				kind: Type.Optional(
					Type.Union([Type.Literal("calls"), Type.Literal("references"), Type.Literal("contains")], {
						description: "Restrict to one edge kind; omit for any kind",
					}),
				),
			}),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const symbols = await codeIntelligenceOperations.reachableFrom(path, params.line, params.character, params.maxDepth, params.kind);
				const text =
					symbols.length === 0
						? "Nothing reachable at this position."
						: symbols.map((s) => `${s.kind} ${s.name} -- ${s.location.path}:${s.location.line}:${s.location.character}`).join("\n");
				return { content: [{ type: "text", text }], details: { symbols } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatReachableFromCall(args as { path?: unknown; line?: unknown; character?: unknown; maxDepth?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Traversing symbol graph..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "reachable_from failed"), 0, 0);
				}
				const details = result.details as { symbols?: readonly SymbolNode[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatReachableFromResult(details?.symbols, expanded, theme));
				return text;
			},
		});

		const gitOperations = createLectorGitOperations();
		pi.registerTool({
			name: "git_status",
			label: "Git Status",
			description:
				"Working tree status for a real git repository -- modified/staged/untracked/renamed files, plus current branch and ahead/behind tracking. Fails clearly if `directory` is not inside a git repository.",
			promptSnippet: "Show a repository's working tree status",
			parameters: Type.Object({
				directory: Type.String({ description: "Directory inside the repository to check, absolute or relative to the current working directory" }),
			}),
			async execute(_toolCallId, params) {
				const directory = resolve(cwd, params.directory);
				const summary = await gitOperations.status(directory);
				return { content: [{ type: "text", text: JSON.stringify(summary) }], details: { summary } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGitStatusCall(args as { directory?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Checking status..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "git_status failed"), 0, 0);
				}
				const details = result.details as { summary?: GitStatusSummary } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGitStatusResult(details?.summary, expanded, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "git_log",
			label: "Git Log",
			description:
				"Recent commits for a real git repository, most recent first, bounded to maxCount. Fails clearly if `directory` is not inside a git repository.",
			promptSnippet: "List a repository's recent commits",
			parameters: Type.Object({
				directory: Type.String({ description: "Directory inside the repository to check, absolute or relative to the current working directory" }),
				maxCount: Type.Number({ description: "Maximum number of commits to return, most recent first" }),
			}),
			async execute(_toolCallId, params) {
				const directory = resolve(cwd, params.directory);
				const entries = await gitOperations.log(directory, params.maxCount);
				const text =
					entries.length === 0 ? "No commits found." : entries.map((e) => `${e.sha.slice(0, 8)} ${e.authoredAt} ${e.authorName} -- ${e.message}`).join("\n");
				return { content: [{ type: "text", text }], details: { entries } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGitLogCall(args as { directory?: unknown; maxCount?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Reading log..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "git_log failed"), 0, 0);
				}
				const details = result.details as { entries?: readonly GitLogEntry[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGitLogResult(details?.entries, expanded, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "git_diff",
			label: "Git Diff",
			description:
				"Unified diff of the working tree against `ref` (defaults to HEAD) for a real git repository, bounded to maxBytes. Fails clearly if `directory` is not inside a git repository.",
			promptSnippet: "Show a repository's working tree diff",
			parameters: Type.Object({
				directory: Type.String({ description: "Directory inside the repository to check, absolute or relative to the current working directory" }),
				ref: Type.Optional(Type.String({ description: "Ref to diff against; defaults to HEAD" })),
				maxBytes: Type.Number({ description: "Maximum diff size in bytes before truncating" }),
			}),
			async execute(_toolCallId, params) {
				const directory = resolve(cwd, params.directory);
				const result = await gitOperations.diff(directory, params.ref, params.maxBytes);
				return { content: [{ type: "text", text: result.diff.length === 0 ? "No differences." : result.diff }], details: { result } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGitDiffCall(args as { directory?: unknown; ref?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Computing diff..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "git_diff failed"), 0, 0);
				}
				const details = result.details as { result?: GitDiffResult } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGitDiffResult(details?.result, expanded, theme));
				return text;
			},
		});

		const searchOperations = createLectorSearchOperations();
		pi.registerTool({
			name: "search_code",
			label: "Search Code",
			description:
				"Multi-file text/regex search scoped to a real project directory, backed by ripgrep -- respects .gitignore, skips node_modules/.git/build output. Bounded by maxMatches and maxBytes; results are cached.",
			promptSnippet: "Search a project's files for a pattern",
			parameters: Type.Object({
				directory: Type.String({ description: "Directory inside the project to search, absolute or relative to the current working directory" }),
				query: Type.String({ description: "Text or regex pattern to search for" }),
				maxMatches: Type.Number({ description: "Maximum number of matches to return before truncating" }),
				maxBytes: Type.Number({ description: "Maximum total bytes of matched line text before truncating" }),
			}),
			async execute(_toolCallId, params) {
				const directory = resolve(cwd, params.directory);
				const result = await searchOperations.search(params.query, directory, params.maxMatches, params.maxBytes);
				const text =
					result.matches.length === 0 ? "No matches found." : result.matches.map((m) => `${m.path}:${m.lineNumber}: ${m.line.replace(/\n$/, "")}`).join("\n");
				return { content: [{ type: "text", text }], details: { result } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatSearchCall(args as { directory?: unknown; query?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "search_code failed"), 0, 0);
				}
				const details = result.details as { result?: TextSearchResult } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatSearchResult(details?.result, expanded, theme));
				return text;
			},
		});

		const repoFetchOperations = createLectorRepoFetchOperations();
		pi.registerTool({
			name: "repo_fetch",
			label: "Repo Fetch",
			description:
				"Shallow-clones an external repository into a disk-bounded cache and registers it as a read-only project -- every other tool (search_code, find_symbols, go_to_definition, ...) then works on it unchanged. Explicit owner/repo[@ref] only, no discovery/search -- use web_fetch to find candidates first.",
			promptSnippet: "Fetch an external open-source repo to search or analyze",
			parameters: Type.Object({
				owner: Type.String({ description: "Repository owner or organization" }),
				repo: Type.String({ description: "Repository name" }),
				ref: Type.Optional(Type.String({ description: "Branch, tag, or commit to fetch; defaults to the repository's default branch" })),
				host: Type.Optional(Type.String({ description: "Git host; defaults to github.com" })),
			}),
			async execute(_toolCallId, params) {
				const result = await repoFetchOperations.fetch(params.host ?? "github.com", params.owner, params.repo, params.ref ?? null);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatRepoFetchCall(args as { owner?: unknown; repo?: unknown; ref?: unknown; host?: unknown }, theme));
				return text;
			},
			renderResult(result, { isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Fetching repository..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "repo_fetch failed"), 0, 0);
				}
				const details = result.details as { result?: RepoFetchResult & { workspaceId: string } } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatRepoFetchResult(details?.result, theme));
				return text;
			},
		});

		const crossWorkspaceSearchOperations = createLectorCrossWorkspaceSearchOperations();
		pi.registerTool({
			name: "find_symbols_across_projects",
			label: "Find Symbols Across Projects",
			description:
				"Fans out a symbol-name search across several explicitly-named project directories at once (e.g. several fetched repos, or a handful of related local projects) and reports one outcome per project -- ready with real results, loading (a project's language server is still cold-starting; retry shortly), or error. Directories are required and explicit -- never every project this daemon happens to have registered, which can include unrelated projects from other concurrent sessions.",
			promptSnippet: "Search for a symbol name across several projects at once",
			parameters: Type.Object({
				directories: Type.Array(Type.String(), { description: "Project directories to search, each absolute or relative to the current working directory" }),
				query: Type.String({ description: "Symbol name (or substring) to search for" }),
				timeoutMs: Type.Optional(Type.Number({ description: "How long to wait per project before reporting it as still-loading; defaults to 3000" })),
			}),
			async execute(_toolCallId, params) {
				const directories = params.directories.map((directory) => resolve(cwd, directory));
				const results = await crossWorkspaceSearchOperations.findSymbols(params.query, directories, params.timeoutMs);
				return { content: [{ type: "text", text: JSON.stringify(results) }], details: { results } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatCrossWorkspaceCall(args as { directories?: unknown; query?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Searching across projects..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "find_symbols_across_projects failed"), 0, 0);
				}
				const details = result.details as { results?: readonly WorkspaceQueryOutcome<{ symbols: readonly WorkspaceSymbol[] }>[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindSymbolsAcrossProjectsResult(details?.results, expanded, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "search_code_across_projects",
			label: "Search Code Across Projects",
			description:
				"Fans out a ripgrep-backed text/regex search across several explicitly-named project directories at once and reports one outcome per project. Directories are required and explicit -- never every project this daemon happens to have registered, which can include unrelated projects from other concurrent sessions.",
			promptSnippet: "Search for a pattern across several projects at once",
			parameters: Type.Object({
				directories: Type.Array(Type.String(), { description: "Project directories to search, each absolute or relative to the current working directory" }),
				query: Type.String({ description: "Text or regex pattern to search for" }),
				maxMatches: Type.Number({ description: "Maximum number of matches to return per project before truncating" }),
				maxBytes: Type.Number({ description: "Maximum total bytes of matched line text to return per project before truncating" }),
				timeoutMs: Type.Optional(Type.Number({ description: "How long to wait per project before reporting it as still-loading; defaults to 3000" })),
			}),
			async execute(_toolCallId, params) {
				const directories = params.directories.map((directory) => resolve(cwd, directory));
				const results = await crossWorkspaceSearchOperations.searchText(params.query, directories, params.maxMatches, params.maxBytes, params.timeoutMs);
				return { content: [{ type: "text", text: JSON.stringify(results) }], details: { results } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatCrossWorkspaceCall(args as { directories?: unknown; query?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Searching across projects..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "search_code_across_projects failed"), 0, 0);
				}
				const details = result.details as { results?: readonly WorkspaceQueryOutcome<TextSearchResult>[] } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatSearchTextAcrossProjectsResult(details?.results, expanded, theme));
				return text;
			},
		});
	});
}
