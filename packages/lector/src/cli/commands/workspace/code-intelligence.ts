import { connectLectorClient } from "../../../client.ts";
import { codeActionPreviewId } from "../../../code-intelligence/code-action.ts";
import { fail, flagValue, hasFlag, parsePosition, parseResponseFormat, requiredIntFlag } from "../../flags.ts";
import { formatCallHierarchyEntry, formatIntelligenceSource, formatSymbolSources } from "../../format.ts";
import { USAGE } from "../../usage.ts";
import type { ActionHandler } from "../action-handler.ts";

/** findSymbols/goToDefinition/goToImplementation/findReferences/hover/documentSymbols/diagnostics/callHierarchy/map/hasWarmIndex -- mirrors service/code-intelligence-handlers.ts + workspace-map-handler.ts's own scope. */

export async function runWorkspaceSymbols(workspaceId: string | undefined, query: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !query) fail(USAGE);
	const seedFile = flagValue(flags, "--seed-file"); // omit to auto-discover one
	const responseFormat = parseResponseFormat(flags);
	const client = await connectLectorClient();
	const result = await client.call("workspace.findSymbols", { workspaceId, query, seedFile, responseFormat });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { symbols, provenance, truncated } = result;
	console.log(`${provenance.fidelity} via ${provenance.backend}${truncated ? " (truncated)" : ""}`);
	for (const source of formatSymbolSources(result)) console.log(source);
	if (symbols.length === 0) {
		console.log(`no symbols matched "${query}"`);
		return;
	}
	for (const symbol of symbols) {
		console.log(`${symbol.kind} ${symbol.name} -- ${symbol.location.path}:${symbol.location.line}:${symbol.location.character}`);
	}
}

export async function runWorkspaceDefinition(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const client = await connectLectorClient();
	const result = await client.call("workspace.goToDefinition", { workspaceId, path, line, character });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { locations, provenance } = result;
	console.log(formatIntelligenceSource(provenance));
	if (locations.length === 0) {
		console.log("no definition found");
		return;
	}
	for (const location of locations) console.log(`${location.path}:${location.line}:${location.character}`);
}

export async function runWorkspaceImplementation(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const client = await connectLectorClient();
	const result = await client.call("workspace.goToImplementation", { workspaceId, path, line, character });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { locations, provenance } = result;
	console.log(formatIntelligenceSource(provenance));
	if (locations.length === 0) {
		console.log("no implementation found");
		return;
	}
	for (const location of locations) console.log(`${location.path}:${location.line}:${location.character}`);
}

export async function runWorkspaceReferences(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const includeDeclaration = hasFlag(flags, "--include-declaration");
	const responseFormat = parseResponseFormat(flags);
	const client = await connectLectorClient();
	const result = await client.call("workspace.findReferences", { workspaceId, path, line, character, includeDeclaration, responseFormat });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { locations, provenance } = result;
	console.log(formatIntelligenceSource(provenance));
	if (locations.length === 0) {
		console.log("no references found");
		return;
	}
	for (const location of locations) console.log(`${location.path}:${location.line}:${location.character}`);
}

export async function runWorkspaceHover(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const client = await connectLectorClient();
	const result = await client.call("workspace.hover", { workspaceId, path, line, character });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(formatIntelligenceSource(result.provenance));
	console.log(result.hover ? result.hover.contents : "no hover information available");
}

export async function runWorkspaceDocumentSymbols(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.documentSymbols", { workspaceId, path });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { symbols, provenance } = result;
	console.log(formatIntelligenceSource(provenance));
	if (symbols.length === 0) {
		console.log("no symbols found");
		return;
	}
	const printEntry = (entry: (typeof symbols)[number], depth: number): void => {
		console.log(`${"  ".repeat(depth)}${entry.kind} ${entry.name} -- ${entry.range.path}:${entry.range.start.line}:${entry.range.start.character}`);
		for (const child of entry.children ?? []) printEntry(child, depth + 1);
	};
	for (const entry of symbols) printEntry(entry, 0);
}

export async function runWorkspaceDiagnostics(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.diagnostics", { workspaceId, path });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { diagnostics, provenance } = result;
	console.log(formatIntelligenceSource(provenance));
	if (diagnostics.length === 0) {
		console.log("no diagnostics");
		return;
	}
	for (const diagnostic of diagnostics) {
		console.log(
			`${diagnostic.severity} ${diagnostic.range.path}:${diagnostic.range.start.line}:${diagnostic.range.start.character} -- ${diagnostic.message}${diagnostic.source ? ` (${diagnostic.source}${diagnostic.code !== undefined ? ` ${diagnostic.code}` : ""})` : ""}`,
		);
	}
}

export async function runWorkspaceDiagnosticDelta(
	workspaceId: string | undefined,
	sourceKind: string | undefined,
	sourceId: string | undefined,
	flags: string[],
): Promise<void> {
	if (!workspaceId || !sourceId || (sourceKind !== "transaction" && sourceKind !== "git")) fail(USAGE);
	const client = await connectLectorClient();
	const source = sourceKind === "transaction" ? ({ kind: "transaction", transactionId: sourceId } as const) : ({ kind: "git", ref: sourceId } as const);
	const gitBounds =
		source.kind === "git"
			? {
					maxDepth: requiredIntFlag(flags, "--max-depth"),
					maxNodes: requiredIntFlag(flags, "--max-nodes"),
					maxEdges: requiredIntFlag(flags, "--max-edges"),
					deadlineMs: requiredIntFlag(flags, "--deadline-ms"),
					maxFiles: requiredIntFlag(flags, "--max-files"),
					maxSymbolsPerFile: requiredIntFlag(flags, "--max-symbols-per-file"),
					autoPopulate: hasFlag(flags, "--auto-populate"),
				}
			: {};
	const result = await client.call("workspace.diagnosticDelta", {
		workspaceId,
		source,
		maxResults: requiredIntFlag(flags, "--max-results"),
		maxBytes: requiredIntFlag(flags, "--max-bytes"),
		...gitBounds,
	});
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	for (const diagnostic of result.introduced)
		console.log(`introduced ${diagnostic.severity} ${diagnostic.range.path}:${diagnostic.range.start.line} -- ${diagnostic.message}`);
	for (const diagnostic of result.resolved)
		console.log(`resolved ${diagnostic.severity} ${diagnostic.range.path}:${diagnostic.range.start.line} -- ${diagnostic.message}`);
	for (const changed of result.changed)
		console.log(`changed ${changed.after.range.path}:${changed.after.range.start.line} -- ${changed.before.message} -> ${changed.after.message}`);
	if (result.truncated) console.log("... truncated");
}

export async function runWorkspaceCallHierarchy(
	subcommand: string | undefined,
	workspaceId: string | undefined,
	path: string | undefined,
	rest: string[],
): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const client = await connectLectorClient();

	if (subcommand === "prepare") {
		const result = await client.call("workspace.prepareCallHierarchy", { workspaceId, path, line, character });
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(result));
			return;
		}
		const { items, provenance } = result;
		console.log(formatIntelligenceSource(provenance));
		if (items.length === 0) {
			console.log("no call-hierarchy root at this position");
			return;
		}
		for (const item of items) console.log(formatCallHierarchyEntry(item));
		return;
	}
	if (subcommand === "incoming") {
		const result = await client.call("workspace.incomingCalls", { workspaceId, path, line, character });
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(result));
			return;
		}
		const { calls, provenance } = result;
		console.log(formatIntelligenceSource(provenance));
		if (calls.length === 0) {
			console.log("no incoming calls found");
			return;
		}
		for (const call of calls) console.log(formatCallHierarchyEntry(call.from));
		return;
	}
	if (subcommand === "outgoing") {
		const result = await client.call("workspace.outgoingCalls", { workspaceId, path, line, character });
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(result));
			return;
		}
		const { calls, provenance } = result;
		console.log(formatIntelligenceSource(provenance));
		if (calls.length === 0) {
			console.log("no outgoing calls found");
			return;
		}
		for (const call of calls) console.log(formatCallHierarchyEntry(call.to));
		return;
	}
	fail(USAGE);
}

export async function runWorkspaceTypeHierarchy(
	direction: string | undefined,
	workspaceId: string | undefined,
	path: string | undefined,
	rest: string[],
): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const client = await connectLectorClient();
	const optionalNumber = (flag: string): number | undefined => {
		const raw = flagValue(flags, flag);
		return raw === undefined ? undefined : Number(raw);
	};
	const maxResults = optionalNumber("--max-results");
	const maxBytes = optionalNumber("--max-bytes");
	const deadlineMs = optionalNumber("--deadline-ms");
	const input = {
		workspaceId,
		path,
		line,
		character,
		...(maxResults !== undefined ? { maxResults } : {}),
		...(maxBytes !== undefined ? { maxBytes } : {}),
		...(deadlineMs !== undefined ? { deadlineMs } : {}),
	};
	const result =
		direction === "prepare"
			? await client.call("workspace.prepareTypeHierarchy", input)
			: direction === "supertypes"
				? await client.call("workspace.supertypes", input)
				: direction === "subtypes"
					? await client.call("workspace.subtypes", input)
					: undefined;
	if (!result) fail(USAGE);
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(formatIntelligenceSource(result.provenance));
	if (result.items.length === 0) {
		console.log("no type-hierarchy items found");
		return;
	}
	for (const item of result.items) console.log(formatCallHierarchyEntry(item));
}

export async function runWorkspaceCodeActions(subcommand: string | undefined, args: string[]): Promise<void> {
	const client = await connectLectorClient();
	if (subcommand === "preview") {
		const [workspaceId, path, startLineRaw, startCharacterRaw, endLineRaw, endCharacterRaw, ...flags] = args;
		if (!workspaceId || !path) fail(USAGE);
		const start = parsePosition(startLineRaw, startCharacterRaw);
		const end = parsePosition(endLineRaw, endCharacterRaw);
		const only = flagValue(flags, "--only")?.split(",").filter(Boolean);
		const result = await client.call("workspace.previewCodeActions", {
			workspaceId,
			path,
			range: { start, end },
			...(only ? { only } : {}),
			includeCommandActions: hasFlag(flags, "--include-command-actions"),
			maxActions: requiredIntFlag(flags, "--max-actions"),
			maxEdits: requiredIntFlag(flags, "--max-edits"),
			maxFiles: requiredIntFlag(flags, "--max-files"),
			maxBytes: requiredIntFlag(flags, "--max-bytes"),
			deadlineMs: requiredIntFlag(flags, "--deadline-ms"),
		});
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(result));
			return;
		}
		console.log(formatIntelligenceSource(result.provenance));
		for (const action of result.actions) {
			console.log(`${action.id} ${action.kind ?? "action"} ${action.title} -- ${action.affectedPaths.join(", ") || "command only"}`);
		}
		if (result.truncated) console.log("... truncated");
		return;
	}
	if (subcommand === "apply") {
		const [workspaceId, previewId, ...flags] = args;
		if (!workspaceId || !previewId) fail(USAGE);
		const result = await client.call("workspace.applyCodeAction", { workspaceId, previewId: codeActionPreviewId(previewId) });
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(result));
			return;
		}
		for (const path of result.touchedPaths) console.log(path);
		if (result.transactionId) console.log(`transaction ${result.transactionId}`);
		if (result.pendingCommand) console.log(`pending command ${result.pendingCommand.command}`);
		return;
	}
	fail(USAGE);
}

export async function runWorkspaceImpactAnalysis(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const ref = flagValue(flags, "--ref");
	const transactionId = flagValue(flags, "--transaction-id");
	if ((ref === undefined) === (transactionId === undefined)) fail(USAGE);
	const source = ref !== undefined ? ({ kind: "git", ref } as const) : ({ kind: "mutation", transactionId: transactionId ?? "" } as const);
	const client = await connectLectorClient();
	const result = await client.call("workspace.impactAnalysis", {
		workspaceId,
		source,
		maxDepth: requiredIntFlag(flags, "--max-depth"),
		maxNodes: requiredIntFlag(flags, "--max-nodes"),
		maxEdges: requiredIntFlag(flags, "--max-edges"),
		maxBytes: requiredIntFlag(flags, "--max-bytes"),
		deadlineMs: requiredIntFlag(flags, "--deadline-ms"),
		maxFiles: requiredIntFlag(flags, "--max-files"),
		maxSymbolsPerFile: requiredIntFlag(flags, "--max-symbols-per-file"),
		autoPopulate: hasFlag(flags, "--auto-populate"),
	});
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	for (const changed of result.changedSymbols)
		console.log(`changed ${changed.side} ${changed.symbol.kind} ${changed.symbol.name} -- ${changed.symbol.location.path}`);
	for (const impacted of result.impactedSymbols)
		console.log(`impact depth=${impacted.depth} ${impacted.symbol.kind} ${impacted.symbol.name} -- ${impacted.symbol.location.path}`);
	for (const test of result.relatedTests) console.log(`test ${test.evidence.kind} ${test.symbol.location.path}`);
	if (result.truncated) console.log("... truncated");
}

export async function runWorkspaceMap(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const maxNodes = requiredIntFlag(flags, "--max-nodes");
	const maxEdges = requiredIntFlag(flags, "--max-edges");
	const maxEntries = requiredIntFlag(flags, "--max-entries");
	const maxBytes = requiredIntFlag(flags, "--max-bytes");
	const client = await connectLectorClient();
	const result = await client.call("workspace.map", { workspaceId, maxNodes, maxEdges, maxEntries, maxBytes });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	if (result.entries.length === 0) {
		console.log("no ranked symbols (has the graph been populated for this workspace?)");
		return;
	}
	for (const entry of result.entries) {
		const signature = entry.signature ? ` -- ${entry.signature}` : "";
		console.log(`${entry.score.toFixed(4)}  ${entry.kind} ${entry.name}  ${entry.path}:${entry.line}:${entry.character}${signature}`);
	}
	if (result.truncated) console.log(`... truncated (${result.totalRanked} ranked total)`);
}

export async function runWorkspaceHasWarmIndex(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const client = await connectLectorClient();
	const { warm } = await client.call("workspace.hasWarmIndex", { workspaceId });
	console.log(hasFlag(flags, "--json") ? JSON.stringify({ warm }) : warm ? "warm" : "not warm");
}

export const CODE_INTELLIGENCE_ACTIONS: Record<string, ActionHandler> = {
	symbols: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceSymbols(workspaceId, path, flags);
	},
	definition: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceDefinition(workspaceId, path, flags);
	},
	implementation: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceImplementation(workspaceId, path, flags);
	},
	references: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceReferences(workspaceId, path, flags);
	},
	hover: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceHover(workspaceId, path, flags);
	},
	"document-symbols": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceDocumentSymbols(workspaceId, path, flags);
	},
	diagnostics: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceDiagnostics(workspaceId, path, flags);
	},
	"diagnostic-delta": (actionArgs) => {
		const [workspaceId, sourceKind, sourceId, ...flags] = actionArgs;
		return runWorkspaceDiagnosticDelta(workspaceId, sourceKind, sourceId, flags);
	},
	"call-hierarchy": (actionArgs) => {
		const [subcommand, chWorkspaceId, chPath, ...chRest] = actionArgs;
		return runWorkspaceCallHierarchy(subcommand, chWorkspaceId, chPath, chRest);
	},
	"type-hierarchy": (actionArgs) => {
		const [direction, hierarchyWorkspaceId, hierarchyPath, ...hierarchyRest] = actionArgs;
		return runWorkspaceTypeHierarchy(direction, hierarchyWorkspaceId, hierarchyPath, hierarchyRest);
	},
	"code-actions": (actionArgs) => {
		const [subcommand, ...args] = actionArgs;
		return runWorkspaceCodeActions(subcommand, args);
	},
	impact: (actionArgs) => {
		const [impactWorkspaceId, ...impactFlags] = actionArgs;
		return runWorkspaceImpactAnalysis(impactWorkspaceId, impactFlags);
	},
	map: (actionArgs) => {
		const [mapWorkspaceId, ...mapFlags] = actionArgs;
		return runWorkspaceMap(mapWorkspaceId, mapFlags);
	},
	"has-warm-index": (actionArgs) => {
		const [hwiWorkspaceId, ...hwiFlags] = actionArgs;
		return runWorkspaceHasWarmIndex(hwiWorkspaceId, hwiFlags);
	},
};
