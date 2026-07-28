import { resolve } from "node:path";
import type {
	ContentHash,
	Diagnostic,
	DocumentSymbolEntry,
	EditOutcome,
	FindFilesResult,
	Hover,
	IntelligenceProvenance,
	JobSnapshot,
	LineEdit,
	LineEditOutcome,
	PackageSourceOperationResult,
	PopulateSymbolGraphResult,
	RepoFetchResult,
	SymbolAnnotation,
	SymbolNode,
	SymbolSearchResult,
	TextSearchResult,
	WorkspaceLocation,
	WorkspaceMapResult,
	WorkspaceQueryOutcome,
} from "@danypops/lector";
import {
	type AgentToolResult,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createLectorApplyPatchOperations } from "./apply-patch-operations.ts";
import { formatApplyPatchCall, formatApplyPatchResult } from "./apply-patch-rendering.ts";
import { createLectorCodeIntelligenceOperations } from "./code-intelligence-operations.ts";
import {
	type CallHierarchyToolDetails,
	describePopulateSymbolGraphJob,
	formatCallHierarchyCall,
	formatCallHierarchyResult,
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
	formatPopulateSymbolGraphCall,
	formatPopulateSymbolGraphResult,
	formatReachableFromCall,
	formatReachableFromResult,
	formatWorkspaceMapCall,
	formatWorkspaceMapResult,
} from "./code-intelligence-rendering.ts";
import { createLectorCrossWorkspaceSearchOperations } from "./cross-workspace-search-operations.ts";
import { formatCrossWorkspaceCall, formatFindSymbolsAcrossProjectsResult, formatSearchTextAcrossProjectsResult } from "./cross-workspace-search-rendering.ts";
import { createLectorEditOperations } from "./edit-operations.ts";
import { createLectorFindFilesOperations } from "./find-files-operations.ts";
import { formatFindFilesCall, formatFindFilesResult } from "./find-files-rendering.ts";
import { createLectorFindSymbolsOperations } from "./find-symbols-operations.ts";
import { describeFindSymbolSources, formatFindSymbolsCall, formatFindSymbolsResult } from "./find-symbols-rendering.ts";
import { createLectorGitOperations } from "./git-operations.ts";
import { formatGitCall, formatGitResult, type GitToolDetails } from "./git-rendering.ts";
import { createLectorLineEditOperations } from "./line-edit-operations.ts";
import { formatLineEditCall, formatLineEditResult } from "./line-edit-rendering.ts";
import { nearestGitRoot } from "./nearest-workspace-root.ts";
import { createLectorPackageSourceOperations } from "./package-source-operations.ts";
import { formatPackageSourceCall, formatPackageSourceResult } from "./package-source-rendering.ts";
import { createLectorReadOperations } from "./read-operations.ts";
import { createLectorRepoFetchOperations } from "./repo-fetch-operations.ts";
import { formatRepoFetchCall, formatRepoFetchResult } from "./repo-fetch-rendering.ts";
import { createLectorSearchOperations } from "./search-operations.ts";
import { formatSearchCall, formatSearchResult } from "./search-rendering.ts";
import { type AnnotationAnchorInput, createLectorSymbolAnnotationOperations } from "./symbol-annotation-operations.ts";
import { formatAnnotationDetail, formatAnnotationListSummary, formatAnnotationSummary } from "./symbol-annotation-rendering.ts";
import {
	type CachePresentationState,
	cacheContextMessage,
	createWorkspaceCacheOperations,
	describeCacheState,
	monitorWorkspaceCache,
} from "./workspace-cache-operations.ts";
import { createLectorWriteOperations } from "./write-operations.ts";

function describeIntelligenceSource(provenance: IntelligenceProvenance): string {
	return `${provenance.fidelity} via ${provenance.backend}`;
}

function renderIntelligenceSource(body: string, provenance: IntelligenceProvenance | undefined, theme: { fg(color: "muted", text: string): string }): string {
	return provenance ? `${theme.fg("muted", describeIntelligenceSource(provenance))}\n${body}` : body;
}

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
	const cacheOperations = createWorkspaceCacheOperations();
	let cacheRun = 0;
	let cacheState: CachePresentationState | undefined;
	let lastInjectedCacheState: string | undefined;

	pi.on("before_agent_start", () => {
		if (!cacheState) return;
		const description = describeCacheState(cacheState);
		if (description === lastInjectedCacheState) return;
		lastInjectedCacheState = description;
		return {
			message: {
				customType: "lector-cache-status",
				content: cacheContextMessage(cacheState),
				display: false,
			},
		};
	});

	pi.on("session_shutdown", (_event, ctx) => {
		cacheRun++;
		cacheState = undefined;
		lastInjectedCacheState = undefined;
		ctx.ui.setStatus("lector-cache", undefined);
	});

	pi.on("session_start", (_event, ctx) => {
		const { cwd } = ctx;
		const projectRoot = nearestGitRoot(cwd);
		const thisRun = ++cacheRun;
		cacheState = undefined;
		lastInjectedCacheState = undefined;
		if (projectRoot) {
			void monitorWorkspaceCache(cacheOperations, {
				directory: projectRoot,
				maxFiles: 500,
				maxSymbolsPerFile: 100,
				pollIntervalMs: 1_000,
				maxPolls: 300,
				shouldContinue: () => cacheRun === thisRun,
				onState: (state) => {
					cacheState = state;
					if (state.status === "finished-caching") {
						if (ctx.hasUI) ctx.ui.notify(`Lector finished caching ${projectRoot}`, "info");
						return;
					}
					const color = state.status === "cached" ? "success" : state.status === "caching" ? "accent" : "warning";
					ctx.ui.setStatus("lector-cache", ctx.ui.theme.fg(color, `Lector: ${describeCacheState(state)}`));
				},
			}).catch((error: unknown) => {
				if (cacheRun !== thisRun) return;
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.setStatus("lector-cache", ctx.ui.theme.fg("error", "Lector: cache error"));
				if (ctx.hasUI) ctx.ui.notify(`Lector cache failed: ${message}`, "error");
			});
		} else {
			ctx.ui.setStatus("lector-cache", undefined);
		}

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
				"other project's directory to get code intelligence there without needing to be in it. Results identify semantic language-server authority or structural compiler/parser fallback.",
			promptSnippet: "Search a workspace for a symbol (function, class, etc.) by name",
			promptGuidelines: [
				"Use find_symbols to locate where a function, class, interface, type, enum, or method is declared by name, instead of grepping for it.",
				"find_symbols' directory argument selects which project to search; it is never inferred, so pass the current working directory explicitly to search the current project, or another project's directory to search that one instead.",
			],
			parameters: Type.Object({
				query: Type.String({ description: "Name or substring to search for, case-insensitive" }),
				directory: Type.String({ description: "Directory of the project to search, absolute or relative to the current working directory" }),
				responseFormat: Type.Optional(
					Type.Union([Type.Literal("concise"), Type.Literal("detailed")], {
						description:
							'"concise" (default "detailed") drops containerName and per-symbol/top-level provenance detail to reduce payload size when you only need name/kind/location',
					}),
				),
			}),
			async execute(_toolCallId, params) {
				const directory = resolve(cwd, params.directory);
				const result = await findSymbolsOperations.findSymbols(params.query, directory, params.responseFormat);
				const { symbols, provenance, truncated } = result;
				const source = `${provenance.fidelity} via ${provenance.backend}${truncated ? " (truncated)" : ""}`;
				const sourceDetails = describeFindSymbolSources(result);
				const heading = [source, ...sourceDetails].join("\n");
				const text =
					symbols.length === 0
						? `${heading}\nNo symbols found matching "${params.query}".`
						: `${heading}\n${symbols
								.map((symbol) => `${symbol.kind} ${symbol.name} -- ${symbol.location.path}:${symbol.location.line}:${symbol.location.character}`)
								.join("\n")}`;
				return { content: [{ type: "text", text }], details: result };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindSymbolsCall(args, theme));
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
				const details = result.details as SymbolSearchResult | undefined;
				const query = typeof context.args.query === "string" ? context.args.query : "";
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindSymbolsResult(details, query, expanded, theme));
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
				const details = await codeIntelligenceOperations.goToDefinition(path, params.line, params.character);
				const text = details.locations.length === 0 ? "No definition found." : details.locations.map((l) => `${l.path}:${l.line}:${l.character}`).join("\n");
				return { content: [{ type: "text", text: `${describeIntelligenceSource(details.provenance)}\n${text}` }], details };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGoToDefinitionCall(args, theme));
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
				const details = result.details as { locations?: readonly WorkspaceLocation[]; provenance?: IntelligenceProvenance } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(renderIntelligenceSource(formatGoToDefinitionResult(details?.locations, expanded, theme), details?.provenance, theme));
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
				const details = await codeIntelligenceOperations.goToImplementation(path, params.line, params.character);
				const text =
					details.locations.length === 0 ? "No implementation found." : details.locations.map((l) => `${l.path}:${l.line}:${l.character}`).join("\n");
				return { content: [{ type: "text", text: `${describeIntelligenceSource(details.provenance)}\n${text}` }], details };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGoToImplementationCall(args, theme));
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
				const details = result.details as { locations?: readonly WorkspaceLocation[]; provenance?: IntelligenceProvenance } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(renderIntelligenceSource(formatGoToImplementationResult(details?.locations, expanded, theme), details?.provenance, theme));
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
				responseFormat: Type.Optional(
					Type.Union([Type.Literal("concise"), Type.Literal("detailed")], {
						description: '"concise" (default "detailed") narrows the provenance detail to reduce payload size',
					}),
				),
			}),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const details = await codeIntelligenceOperations.findReferences(path, params.line, params.character, params.includeDeclaration, params.responseFormat);
				const text = details.locations.length === 0 ? "No references found." : details.locations.map((l) => `${l.path}:${l.line}:${l.character}`).join("\n");
				return { content: [{ type: "text", text: `${describeIntelligenceSource(details.provenance)}\n${text}` }], details };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindReferencesCall(args, theme));
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
				const details = result.details as { locations?: readonly WorkspaceLocation[]; provenance?: IntelligenceProvenance } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(renderIntelligenceSource(formatFindReferencesResult(details?.locations, expanded, theme), details?.provenance, theme));
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
				const details = await codeIntelligenceOperations.hover(path, params.line, params.character);
				return {
					content: [
						{ type: "text", text: `${describeIntelligenceSource(details.provenance)}\n${details.hover?.contents ?? "No hover information available."}` },
					],
					details,
				};
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatHoverCall(args, theme));
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
				const details = result.details as { hover?: Hover; provenance?: IntelligenceProvenance } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(renderIntelligenceSource(formatHoverResult(details?.hover, expanded, theme), details?.provenance, theme));
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
				const details = await codeIntelligenceOperations.documentSymbols(path);
				const text = details.symbols.length === 0 ? "No symbols found." : details.symbols.map((s) => `${s.kind} ${s.name}`).join("\n");
				return { content: [{ type: "text", text: `${describeIntelligenceSource(details.provenance)}\n${text}` }], details };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatDocumentSymbolsCall(args, theme));
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
				const details = result.details as { symbols?: readonly DocumentSymbolEntry[]; provenance?: IntelligenceProvenance } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(renderIntelligenceSource(formatDocumentSymbolsResult(details?.symbols, expanded, theme), details?.provenance, theme));
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
				const details = await codeIntelligenceOperations.diagnostics(path);
				const text =
					details.diagnostics.length === 0
						? "No diagnostics."
						: details.diagnostics.map((d) => `${d.severity} ${d.range.path}:${d.range.start.line}:${d.range.start.character} -- ${d.message}`).join("\n");
				return { content: [{ type: "text", text: `${describeIntelligenceSource(details.provenance)}\n${text}` }], details };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatDiagnosticsCall(args, theme));
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
				const details = result.details as { diagnostics?: readonly Diagnostic[]; provenance?: IntelligenceProvenance } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(renderIntelligenceSource(formatDiagnosticsResult(details?.diagnostics, expanded, theme), details?.provenance, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "call_hierarchy",
			label: "Call Hierarchy",
			description:
				"Resolve the symbol at an exact file position to its call-hierarchy root, or find its real callers/callees, project-wide, in one tool. ACTIONS: prepare (confirm what the position resolves to), incoming (who actually calls it, as distinct from find_references which also finds non-call usages), outgoing (what it itself calls).",
			promptSnippet: "Resolve a position to a call-hierarchy root, or find its callers/callees",
			promptGuidelines: [
				"direction=prepare is optional -- incoming/outgoing already resolve the position internally, so calling prepare first is never required, only useful to confirm what a position resolves to.",
				"direction=incoming finds real callers, distinct from find_references which also finds non-call usages like type positions or re-exports.",
			],
			parameters: Type.Object({
				direction: Type.String({ description: "prepare | incoming | outgoing" }),
				...positionParameters,
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<CallHierarchyToolDetails>> {
				const path = resolve(cwd, params.path);
				if (params.direction === "prepare") {
					const { items, provenance } = await codeIntelligenceOperations.prepareCallHierarchy(path, params.line, params.character);
					const text =
						items.length === 0
							? "No call-hierarchy root at this position."
							: items.map((i) => `${i.kind} ${i.name} -- ${i.location.path}:${i.location.line}:${i.location.character}`).join("\n");
					const details: CallHierarchyToolDetails = { direction: "prepare", items, provenance };
					return { content: [{ type: "text", text: `${describeIntelligenceSource(provenance)}\n${text}` }], details };
				}
				if (params.direction === "incoming") {
					const { calls, provenance } = await codeIntelligenceOperations.incomingCalls(path, params.line, params.character);
					const text =
						calls.length === 0
							? "No incoming calls found."
							: calls.map((c) => `${c.from.kind} ${c.from.name} -- ${c.from.location.path}:${c.from.location.line}:${c.from.location.character}`).join("\n");
					const details: CallHierarchyToolDetails = { direction: "incoming", calls, provenance };
					return { content: [{ type: "text", text: `${describeIntelligenceSource(provenance)}\n${text}` }], details };
				}
				if (params.direction === "outgoing") {
					const { calls, provenance } = await codeIntelligenceOperations.outgoingCalls(path, params.line, params.character);
					const text =
						calls.length === 0
							? "No outgoing calls found."
							: calls.map((c) => `${c.to.kind} ${c.to.name} -- ${c.to.location.path}:${c.to.location.line}:${c.to.location.character}`).join("\n");
					const details: CallHierarchyToolDetails = { direction: "outgoing", calls, provenance };
					return { content: [{ type: "text", text: `${describeIntelligenceSource(provenance)}\n${text}` }], details };
				}
				throw new Error(`unknown call_hierarchy direction: ${String(params.direction)}`);
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatCallHierarchyCall(args, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Resolving call hierarchy..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "call_hierarchy failed"), 0, 0);
				}
				const details = result.details as CallHierarchyToolDetails | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(renderIntelligenceSource(formatCallHierarchyResult(details, expanded, theme), details?.provenance, theme));
				return text;
			},
		});

		pi.registerTool({
			name: "populate_symbol_graph",
			label: "Populate Symbol Graph",
			description:
				"Walk a workspace's real call relationships into a persisted graph, so reachable_from can answer multi-hop questions (transitive callers, reachability) without chaining many find_references/call_hierarchy calls by hand. Run this once before reachable_from.",
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
				text.setText(formatPopulateSymbolGraphCall(args, theme));
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

		const symbolAnnotationOperations = createLectorSymbolAnnotationOperations();
		function resolveAnchorInputs(anchors: readonly { path: string; line: number; character: number }[]): AnnotationAnchorInput[] {
			return anchors.map((anchor) => ({ path: resolve(cwd, anchor.path), line: anchor.line, character: anchor.character }));
		}
		interface SymbolAnnotationToolDetails {
			annotation?: SymbolAnnotation;
			annotations?: readonly SymbolAnnotation[];
			scrubbed?: boolean;
			restored?: boolean;
		}

		pi.registerTool({
			name: "symbol_annotations",
			label: "Symbol Annotations",
			description:
				'Agent-authored narrative content anchored to one or more symbols in the workspace\'s persisted graph -- e.g. a "user story dataflow" note spanning every symbol touched end-to-end. Every anchor must resolve to a real, currently-known symbol (run populate_symbol_graph first). get/list live-check staleness against the current graph/workspace on every call and persist a correction before returning, so a returned status never disagrees with reality -- a stale annotation must be refreshed (re-authored and re-anchored) or scrubbed (soft-deleted, restorable) by an explicit decision; Lector never rewrites the narrative itself. Actions: create, get, list, refresh, scrub, restore.',
			promptSnippet: "Attach, read, or invalidate narrative annotations on the symbol graph",
			promptGuidelines: [
				"Resolve real anchor positions first (find_symbols/document_symbols/go_to_definition) -- an anchor position must match populate_symbol_graph's own recorded position for that symbol, not just any occurrence of its name.",
				"A stale annotation's body may no longer describe the code accurately -- read it, decide whether to refresh (re-author) or scrub (remove), never trust it as-is.",
			],
			parameters: Type.Object({
				action: Type.String({ description: "create | get | list | refresh | scrub | restore" }),
				path: Type.String({ description: "Absolute or cwd-relative path used to resolve which workspace this annotation belongs to" }),
				id: Type.Optional(Type.String({ description: "Annotation id -- required for get/refresh/scrub/restore" })),
				subtype: Type.Optional(Type.String({ description: 'Free-form kind, e.g. "user-story-dataflow" or "comment" -- required for create/refresh' })),
				title: Type.Optional(Type.String({ description: "Required for create/refresh" })),
				body: Type.Optional(Type.String({ description: "The narrative content -- required for create/refresh" })),
				anchors: Type.Optional(
					Type.Array(
						Type.Object({
							path: Type.String({ description: "Absolute or cwd-relative path to the anchored file" }),
							line: Type.Number({ description: "1-indexed line number" }),
							character: Type.Number({ description: "1-indexed character offset within the line" }),
						}),
						{ description: "At least one required for create/refresh -- each must resolve to a real, currently-known symbol" },
					),
				),
				listStatus: Type.Optional(Type.String({ description: "fresh | stale | scrubbed -- for list; defaults to excluding scrubbed" })),
				listSubtype: Type.Optional(Type.String({ description: "For list: filter by subtype" })),
				maxResults: Type.Optional(Type.Number({ description: "For list: bounds the number of results" })),
			}),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const details: SymbolAnnotationToolDetails = {};
				let text: string;
				if (params.action === "create") {
					if (!params.subtype || !params.title || params.body === undefined || !params.anchors || params.anchors.length === 0) {
						throw new Error("symbol_annotations create requires subtype, title, body, and at least one anchor");
					}
					const { annotation } = await symbolAnnotationOperations.create(path, params.subtype, params.title, params.body, resolveAnchorInputs(params.anchors));
					details.annotation = annotation;
					text = formatAnnotationDetail(annotation);
				} else if (params.action === "get") {
					if (!params.id) throw new Error("symbol_annotations get requires id");
					const { annotation } = await symbolAnnotationOperations.get(path, params.id);
					details.annotation = annotation;
					text = annotation ? formatAnnotationDetail(annotation) : `no annotation "${params.id}"`;
				} else if (params.action === "list") {
					const status = params.listStatus === "fresh" || params.listStatus === "stale" || params.listStatus === "scrubbed" ? params.listStatus : undefined;
					const { annotations } = await symbolAnnotationOperations.list(path, { subtype: params.listSubtype, status, maxResults: params.maxResults });
					details.annotations = annotations;
					text = annotations.length === 0 ? "no annotations" : annotations.map(formatAnnotationDetail).join("\n\n");
				} else if (params.action === "refresh") {
					if (!params.id || !params.subtype || !params.title || params.body === undefined || !params.anchors || params.anchors.length === 0) {
						throw new Error("symbol_annotations refresh requires id, subtype, title, body, and at least one anchor");
					}
					const { annotation } = await symbolAnnotationOperations.refresh(
						path,
						params.id,
						params.subtype,
						params.title,
						params.body,
						resolveAnchorInputs(params.anchors),
					);
					details.annotation = annotation;
					text = annotation ? formatAnnotationDetail(annotation) : `no annotation "${params.id}"`;
				} else if (params.action === "scrub") {
					if (!params.id) throw new Error("symbol_annotations scrub requires id");
					const { scrubbed } = await symbolAnnotationOperations.scrub(path, params.id);
					details.scrubbed = scrubbed;
					text = scrubbed ? `scrubbed ${params.id}` : `"${params.id}" was already scrubbed or does not exist`;
				} else if (params.action === "restore") {
					if (!params.id) throw new Error("symbol_annotations restore requires id");
					const { restored } = await symbolAnnotationOperations.restore(path, params.id);
					details.restored = restored;
					text = restored ? `restored ${params.id}` : `"${params.id}" was not scrubbed or does not exist`;
				} else {
					throw new Error(`unknown symbol_annotations action: ${String(params.action)}`);
				}
				return { content: [{ type: "text", text }], details };
			},
			renderCall(args, theme, context) {
				const action = typeof args.action === "string" ? args.action : "";
				const id = typeof args.id === "string" ? ` ${args.id}` : "";
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(`${theme.fg("toolTitle", theme.bold("symbol_annotations"))} ${theme.fg("accent", action)}${theme.fg("dim", id)}`);
				return text;
			},
			renderResult(result, { isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Working on annotation..."), 0, 0);
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					text.setText(theme.fg("error", errorText || "symbol_annotations failed"));
					return text;
				}
				const details = result.details as SymbolAnnotationToolDetails | undefined;
				if (details?.annotations) {
					text.setText(formatAnnotationListSummary(details.annotations, theme));
					return text;
				}
				if (details?.annotation) {
					text.setText(formatAnnotationSummary(details.annotation, theme));
					return text;
				}
				if (details?.scrubbed !== undefined) {
					text.setText(details.scrubbed ? theme.fg("success", "scrubbed") : theme.fg("muted", "already scrubbed or not found"));
					return text;
				}
				if (details?.restored !== undefined) {
					text.setText(details.restored ? theme.fg("success", "restored") : theme.fg("muted", "not scrubbed or not found"));
					return text;
				}
				text.setText(theme.fg("muted", "done"));
				return text;
			},
		});

		pi.registerTool({
			name: "reachable_from",
			label: "Reachable From",
			description:
				"Every symbol reachable from an exact file position by following the workspace's persisted call graph up to maxDepth hops -- transitive callers/reachability that would otherwise require chaining many find_references/call_hierarchy calls by hand. Requires populate_symbol_graph to have been run for this workspace first.",
			promptSnippet: "Find symbols reachable from a position, up to N hops, via the persisted graph",
			promptGuidelines: [
				"Use reachable_from for multi-hop questions (does A eventually call C through B); use call_hierarchy (direction=incoming/outgoing) for a single direct hop live against the language server.",
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
				text.setText(formatReachableFromCall(args, theme));
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

		pi.registerTool({
			name: "workspace_map",
			label: "Workspace Map",
			description:
				"A ranked, budget-bounded summary of the workspace's most structurally central symbols (aider-repomap-shaped) -- signature-only, highest-ranked first by PageRank over the populated call/reference graph, not full file dumps. Use when orienting in an unfamiliar or large codebase instead of reading many files one by one. Requires populate_symbol_graph to have been run for this workspace first; returns empty otherwise.",
			promptSnippet: "Get a ranked, signature-only overview of the workspace's most central symbols",
			promptGuidelines: [
				"Prefer this over reading many files to get oriented in a large or unfamiliar codebase -- it surfaces the most-referenced symbols first, not an arbitrary file order.",
				"A budget-truncated result means real symbols were left out, not that the workspace only has this many -- raise maxEntries/maxBytes for more.",
			],
			parameters: Type.Object({
				path: Type.String({ description: "Absolute or cwd-relative path used to resolve which workspace to map" }),
				maxNodes: Type.Number({ description: "Bounds the raw fetch from the graph before ranking" }),
				maxEdges: Type.Number({ description: "Bounds the raw fetch from the graph before ranking" }),
				maxEntries: Type.Number({ description: "Hard cap on the number of ranked entries returned" }),
				maxBytes: Type.Number({ description: "Soft byte budget -- stops adding entries once exceeded, even under maxEntries" }),
			}),
			async execute(_toolCallId, params) {
				const path = resolve(cwd, params.path);
				const result = await codeIntelligenceOperations.workspaceMap(path, params.maxNodes, params.maxEdges, params.maxEntries, params.maxBytes);
				const text =
					result.entries.length === 0
						? "No ranked symbols (has the graph been populated for this workspace?)."
						: result.entries
								.map(
									(entry) => `${entry.kind} ${entry.name} -- ${entry.path}:${entry.line}:${entry.character}${entry.signature ? ` -- ${entry.signature}` : ""}`,
								)
								.join("\n");
				return { content: [{ type: "text", text }], details: { result } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatWorkspaceMapCall(args, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Ranking workspace symbols..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "workspace_map failed"), 0, 0);
				}
				const details = result.details as { result?: WorkspaceMapResult } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatWorkspaceMapResult(details?.result, expanded, theme));
				return text;
			},
		});

		const gitOperations = createLectorGitOperations();
		pi.registerTool({
			name: "git",
			label: "Git",
			description:
				"Working tree status, recent commit log, and unified diff for a real git repository, in one tool. Fails clearly if `directory` is not inside a git repository. ACTIONS: status (working tree state, ahead/behind tracking), log (recent commits, bounded by maxCount), diff (unified diff against `ref`, defaulting to HEAD, bounded by maxBytes).",
			promptSnippet: "Show a repository's status, log, or diff",
			promptGuidelines: [
				"maxCount is required for action=log; maxBytes is required for action=diff -- every bounded query needs its bound stated explicitly, never defaulted silently.",
			],
			parameters: Type.Object({
				action: Type.String({ description: "status | log | diff" }),
				directory: Type.String({ description: "Directory inside the repository to check, absolute or relative to the current working directory" }),
				maxCount: Type.Optional(Type.Number({ description: "Maximum number of commits to return, most recent first -- required for action=log" })),
				ref: Type.Optional(Type.String({ description: "Ref to diff against; defaults to HEAD -- only used for action=diff" })),
				maxBytes: Type.Optional(Type.Number({ description: "Maximum diff size in bytes before truncating -- required for action=diff" })),
			}),
			async execute(_toolCallId, params) {
				const directory = resolve(cwd, params.directory);
				if (params.action === "status") {
					const summary = await gitOperations.status(directory);
					const details: GitToolDetails = { action: "status", summary };
					return { content: [{ type: "text", text: JSON.stringify(summary) }], details };
				}
				if (params.action === "log") {
					if (params.maxCount === undefined) throw new Error("git action=log requires maxCount");
					const entries = await gitOperations.log(directory, params.maxCount);
					const text =
						entries.length === 0 ? "No commits found." : entries.map((e) => `${e.sha.slice(0, 8)} ${e.authoredAt} ${e.authorName} -- ${e.message}`).join("\n");
					const details: GitToolDetails = { action: "log", entries };
					return { content: [{ type: "text", text }], details };
				}
				if (params.action === "diff") {
					if (params.maxBytes === undefined) throw new Error("git action=diff requires maxBytes");
					const result = await gitOperations.diff(directory, params.ref, params.maxBytes);
					const details: GitToolDetails = { action: "diff", result };
					return { content: [{ type: "text", text: result.diff.length === 0 ? "No differences." : result.diff }], details };
				}
				throw new Error(`unknown git action: ${String(params.action)}`);
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGitCall(args, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Running git..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "git failed"), 0, 0);
				}
				const details = result.details as GitToolDetails | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatGitResult(details, expanded, theme));
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
				text.setText(formatSearchCall(args, theme));
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

		const findFilesOperations = createLectorFindFilesOperations();
		pi.registerTool({
			name: "find_files",
			label: "Find Files",
			description:
				"Find files by glob/name pattern, distinct from content search -- the `find` half of the classic grep+find pair. Backed by ripgrep's own --files listing, respects .gitignore, skips node_modules/.git/build output. Bounded by maxResults and maxBytes.",
			promptSnippet: "Find files by path/name glob pattern, not content",
			promptGuidelines: [
				"Use find_files to locate files by path or name pattern (e.g. every *.test.ts under a directory) -- use search_code instead when you need to match file content, not just the path.",
			],
			parameters: Type.Object({
				directory: Type.String({ description: "Directory inside the project to search, absolute or relative to the current working directory" }),
				patterns: Type.Array(Type.String(), {
					description: "Glob pattern(s) to match file paths against, OR'd together -- a file matching any one pattern is included",
					minItems: 1,
				}),
				maxResults: Type.Number({ description: "Maximum number of file paths to return before truncating" }),
				maxBytes: Type.Number({ description: "Maximum total bytes of matched path text before truncating" }),
			}),
			async execute(_toolCallId, params) {
				const directory = resolve(cwd, params.directory);
				const result = await findFilesOperations.findFiles(params.patterns, directory, params.maxResults, params.maxBytes);
				const text = result.paths.length === 0 ? "No files found." : result.paths.join("\n");
				return { content: [{ type: "text", text }], details: { result } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindFilesCall(args, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Finding files..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "find_files failed"), 0, 0);
				}
				const details = result.details as { result?: FindFilesResult } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindFilesResult(details?.result, expanded, theme));
				return text;
			},
		});

		const lineEditOperations = createLectorLineEditOperations();
		pi.registerTool({
			name: "line_edit",
			label: "Line Edit",
			description:
				"Applies one or more per-line-hash-guarded edits to a file, atomically -- distinct from the generic edit tool's whole-file hash guard. A concurrent change to a line no edit here references never invalidates this call, unlike a whole-file guard where any edit anywhere in the file forces a re-read. Each edit's lines must currently hold the given hash(es) (from read tool content: hash each line's exact text yourself, or retry using the actualHash a hash-mismatch failure reports). All edits in one call land together, or none do.",
			promptSnippet: "Apply per-line hash-guarded edits to a file, atomically",
			promptGuidelines: [
				"Prefer line_edit over the generic edit tool when editing a large or heavily concurrent file where you only need to touch a few specific lines -- it survives a concurrent change elsewhere in the file that a whole-file hash guard would reject.",
				"A line's hash is not given to you ahead of time -- compute it yourself from content you already read (same algorithm as lineHashOf: sha256 of the exact line text, first 8 hex characters), or attempt the edit and use the actualHash a hash-mismatch failure reports to retry.",
			],
			parameters: Type.Object({
				path: Type.String({ description: "Absolute or workspace-relative path to the file to edit" }),
				edits: Type.Array(
					Type.Union([
						Type.Object({
							kind: Type.Literal("replace"),
							startLine: Type.Number({ description: "1-indexed first line of the inclusive range to replace" }),
							endLine: Type.Number({ description: "1-indexed last line of the inclusive range to replace (same as startLine for a single line)" }),
							expectedStartHash: Type.String({ description: "The hash startLine must currently hold" }),
							expectedEndHash: Type.String({
								description: "The hash endLine must currently hold (same value as expectedStartHash when startLine === endLine)",
							}),
							lines: Type.Array(Type.String(), { description: "Replacement lines -- an empty array deletes the range" }),
						}),
						Type.Object({
							kind: Type.Literal("insertBefore"),
							atLine: Type.Number({ description: "1-indexed anchor line to insert before" }),
							expectedHash: Type.String({ description: "The hash atLine must currently hold" }),
							lines: Type.Array(Type.String(), { description: "Lines to insert" }),
						}),
						Type.Object({
							kind: Type.Literal("insertAfter"),
							atLine: Type.Number({ description: "1-indexed anchor line to insert after" }),
							expectedHash: Type.String({ description: "The hash atLine must currently hold" }),
							lines: Type.Array(Type.String(), { description: "Lines to insert" }),
						}),
					]),
					{ description: "One or more edits, all applied atomically -- non-overlapping line ranges required", minItems: 1 },
				),
			}),
			async execute(_toolCallId, params) {
				const absolutePath = resolve(cwd, params.path);
				// The Pi tool schema can only express plain strings for hash fields (TypeBox has no
				// concept of Lector's branded LineHash) -- the daemon's own domain validation is the
				// real runtime check regardless of what TypeScript sees at this call site.
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
				const result = await lineEditOperations.lineEdit(absolutePath, params.edits as unknown as LineEdit[]);
				return { content: [{ type: "text", text: `${result.path}: ${result.previousHash} -> ${result.newHash}` }], details: { result } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatLineEditCall(args, theme));
				return text;
			},
			renderResult(result, { isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Applying line edit..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "line_edit failed"), 0, 0);
				}
				const details = result.details as { result?: LineEditOutcome } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatLineEditResult(details?.result, theme));
				return text;
			},
		});

		const applyPatchOperations = createLectorApplyPatchOperations();
		pi.registerTool({
			name: "apply_patch",
			label: "Apply Patch",
			description:
				"Applies a real unified diff (as `diff -u` / `git diff` produce) to a file, guarded by the whole-file hash you last observed there -- distinct from line_edit's per-line guards and the generic edit tool's plain replace. Hunk context is searched for near its own line-number hint rather than trusted as an exact offset, so the patch still applies correctly even if the file shifted slightly (e.g. unrelated lines added elsewhere) since the diff was generated.",
			promptSnippet: "Apply a real unified diff to a file, whole-file hash guarded",
			promptGuidelines: [
				"Use apply_patch when you already have a unified diff (e.g. from a prior read's content, or produced by a diffing step) rather than reconstructing the full post-patch content yourself for the generic edit tool.",
				"If a hunk's context can no longer be found, the file has drifted too far from what the patch assumed -- re-read the file and regenerate the patch, the same response as a stale hash on any other Lector edit tool.",
			],
			parameters: Type.Object({
				path: Type.String({ description: "Absolute or workspace-relative path to the file to patch" }),
				expectedHash: Type.String({ description: "The whole-file hash you last observed at path (from a prior read)" }),
				patchText: Type.String({
					description: "Real unified-diff text with one or more @@ hunks (--- / +++ file-header lines are optional and ignored if present)",
				}),
			}),
			async execute(_toolCallId, params) {
				const absolutePath = resolve(cwd, params.path);
				// TypeBox has no concept of Lector's branded ContentHash -- the daemon's own domain
				// validation is the real runtime check regardless of what TypeScript sees here.
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
				const result = await applyPatchOperations.applyPatch(absolutePath, params.expectedHash as ContentHash, params.patchText);
				return { content: [{ type: "text", text: `${result.path}: ${result.previousHash ?? "(new)"} -> ${result.newHash}` }], details: { result } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatApplyPatchCall(args, theme));
				return text;
			},
			renderResult(result, { isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Applying patch..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "apply_patch failed"), 0, 0);
				}
				const details = result.details as { result?: EditOutcome } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatApplyPatchResult(details?.result, theme));
				return text;
			},
		});

		const packageSourceOperations = createLectorPackageSourceOperations();
		pi.registerTool({
			name: "package_source",
			label: "Package Source",
			description:
				"Resolve an installed npm package to verified exact repository source. Uses the project's lockfile, bounded registry metadata, and an exact Git ref/commit; registers verified source as a read-only workspace for the other Lector tools.",
			promptSnippet: "Resolve an installed npm package to exact read-only source",
			parameters: Type.Object({
				directory: Type.String({ description: "Project directory containing the npm-family lockfile" }),
				name: Type.String({ description: "Installed package name, including scope when present" }),
				version: Type.Optional(Type.String({ description: "Exact installed version; required when the lockfile contains several versions" })),
				registry: Type.Optional(Type.String({ description: "npm registry URL; defaults to the public npm registry" })),
			}),
			async execute(_toolCallId, params) {
				const directory = resolve(cwd, params.directory);
				const result = await packageSourceOperations.resolve(directory, params.name, params.version ?? null, params.registry ?? null);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatPackageSourceCall(args, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Resolving package source..."), 0, 0);
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "package_source failed"), 0, 0);
				}
				const details = result.details as { result?: PackageSourceOperationResult } | undefined;
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatPackageSourceResult(details?.result, expanded, theme));
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
				text.setText(formatRepoFetchCall(args, theme));
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
				text.setText(formatCrossWorkspaceCall(args, theme));
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
				const details = result.details as { results?: readonly WorkspaceQueryOutcome<SymbolSearchResult>[] } | undefined;
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
				text.setText(formatCrossWorkspaceCall(args, theme));
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
