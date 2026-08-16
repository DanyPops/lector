import { connectLectorClient } from "../../../client.ts";
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
	"call-hierarchy": (actionArgs) => {
		const [subcommand, chWorkspaceId, chPath, ...chRest] = actionArgs;
		return runWorkspaceCallHierarchy(subcommand, chWorkspaceId, chPath, chRest);
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
