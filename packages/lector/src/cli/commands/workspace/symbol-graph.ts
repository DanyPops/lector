import { connectLectorClient } from "../../../client.ts";
import { fail, flagValue, hasFlag, parsePosition, parseSymbolEdgeKind, requiredIntFlag } from "../../flags.ts";
import { formatCacheGenerationSummaryResult, formatIntelligenceSource, formatJobSnapshot, formatPopulationResult, formatSymbolNode } from "../../format.ts";
import { USAGE } from "../../usage.ts";
import type { ActionHandler } from "../action-handler.ts";

/** populateSymbolGraph/cacheStatus/referenceBasedRename/prepareRename/rename/reachableFrom+symbolEdgesFrom+symbolEdgesTo -- mirrors service/symbol-graph-handlers.ts's own scope. */

export async function runWorkspacePopulateSymbolGraph(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const maxFiles = requiredIntFlag(flags, "--max-files");
	const maxSymbolsPerFile = requiredIntFlag(flags, "--max-symbols-per-file");
	const client = await connectLectorClient();
	if (hasFlag(flags, "--background")) {
		const waitMsRaw = flagValue(flags, "--wait-ms");
		const waitMs = waitMsRaw === undefined ? 0 : Number(waitMsRaw);
		const { job } = await client.call("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId, maxFiles, maxSymbolsPerFile },
			waitMs,
		});
		console.log(hasFlag(flags, "--json") ? JSON.stringify(job) : formatJobSnapshot(job));
		return;
	}
	const result = await client.call("workspace.populateSymbolGraph", { workspaceId, maxFiles, maxSymbolsPerFile });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : formatPopulationResult(result));
}

export async function runWorkspaceCacheStatus(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const maxFiles = requiredIntFlag(flags, "--max-files");
	const maxSymbolsPerFile = requiredIntFlag(flags, "--max-symbols-per-file");
	const client = await connectLectorClient();
	const status = await client.call("workspace.cacheStatus", { workspaceId, maxFiles, maxSymbolsPerFile });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(status));
		return;
	}
	if (status.status === "not-cached") console.log(`not cached -- ${status.reason}`);
	else if (status.status === "caching") console.log(`caching -- job ${status.jobId}`);
	else if (status.status === "waiting-for-resources") console.log(`waiting for resources -- job ${status.jobId} is queued behind foreground work`);
	else if (status.status === "partial") console.log(`partially cached -- ${formatCacheGenerationSummaryResult(status.generation.result)}`);
	else console.log(`cached -- completed ${new Date(status.generation.completedAt).toISOString()}`);
}

export async function runWorkspaceReferenceBasedRename(
	workspaceId: string | undefined,
	fromPath: string | undefined,
	toPath: string | undefined,
	flags: string[],
): Promise<void> {
	if (!workspaceId || !fromPath || !toPath) fail(USAGE);
	const maxFiles = requiredIntFlag(flags, "--max-files");
	const maxSymbolsPerFile = requiredIntFlag(flags, "--max-symbols-per-file");
	const client = await connectLectorClient();
	const outcome = await client.call("workspace.referenceBasedRename", { workspaceId, fromPath, toPath, maxFiles, maxSymbolsPerFile });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(outcome));
		return;
	}
	console.log(`moved to ${outcome.movedTo}`);
	if (outcome.filesUpdated.length === 0) console.log("no other files referenced it");
	else for (const path of outcome.filesUpdated) console.log(`updated import: ${path}`);
	for (const caveat of outcome.caveats) console.log(`caveat: ${caveat}`);
}

export async function runWorkspacePrepareRename(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const client = await connectLectorClient();
	const result = await client.call("workspace.prepareRename", { workspaceId, path, line, character });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(formatIntelligenceSource(result.provenance));
	if (!result.range) {
		console.log("nothing renameable at this position");
		return;
	}
	if (!result.range.range) {
		console.log("renameable here (server left the exact range to the client)");
		return;
	}
	const { path: rangePath, start, end } = result.range.range;
	console.log(`renameable: ${rangePath}:${start.line}:${start.character}-${end.character}`);
}

export async function runWorkspaceRename(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, newName, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	if (!newName) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.rename", { workspaceId, path, line, character, newName });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(formatIntelligenceSource(result.provenance));
	for (const touched of result.touchedPaths) console.log(`updated: ${touched}`);
}

export async function runWorkspaceSymbolGraphQuery(
	subcommand: string | undefined,
	workspaceId: string | undefined,
	path: string | undefined,
	rest: string[],
): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const kind = parseSymbolEdgeKind(flags);
	const client = await connectLectorClient();

	if (subcommand === "reachable-from") {
		const maxDepth = requiredIntFlag(flags, "--max-depth");
		const { symbols } = await client.call("workspace.reachableFrom", { workspaceId, path, line, character, maxDepth, kind });
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(symbols));
			return;
		}
		if (symbols.length === 0) {
			console.log("nothing reachable at this position (has the graph been populated for this workspace?)");
			return;
		}
		for (const symbol of symbols) console.log(formatSymbolNode(symbol));
		return;
	}
	if (subcommand === "edges-from" || subcommand === "edges-to") {
		const operation = subcommand === "edges-from" ? "workspace.symbolEdgesFrom" : "workspace.symbolEdgesTo";
		const { symbols } = await client.call(operation, { workspaceId, path, line, character, kind });
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(symbols));
			return;
		}
		if (symbols.length === 0) {
			console.log("no edges found (has the graph been populated for this workspace?)");
			return;
		}
		for (const symbol of symbols) console.log(formatSymbolNode(symbol));
		return;
	}
	fail(USAGE);
}

export const SYMBOL_GRAPH_ACTIONS: Record<string, ActionHandler> = {
	"populate-symbol-graph": (actionArgs) => {
		const [psgWorkspaceId, ...psgFlags] = actionArgs;
		return runWorkspacePopulateSymbolGraph(psgWorkspaceId, psgFlags);
	},
	"symbol-graph": (actionArgs) => {
		const [subcommand, sgWorkspaceId, sgPath, ...sgRest] = actionArgs;
		return runWorkspaceSymbolGraphQuery(subcommand, sgWorkspaceId, sgPath, sgRest);
	},
	"cache-status": (actionArgs) => {
		const [cacheWorkspaceId, ...cacheFlags] = actionArgs;
		return runWorkspaceCacheStatus(cacheWorkspaceId, cacheFlags);
	},
	"reference-based-rename": (actionArgs) => {
		const [rbrWorkspaceId, rbrFromPath, rbrToPath, ...rbrFlags] = actionArgs;
		return runWorkspaceReferenceBasedRename(rbrWorkspaceId, rbrFromPath, rbrToPath, rbrFlags);
	},
	"prepare-rename": (actionArgs) => {
		const [prWorkspaceId, prPath, ...prRest] = actionArgs;
		return runWorkspacePrepareRename(prWorkspaceId, prPath, prRest);
	},
	rename: (actionArgs) => {
		const [renWorkspaceId, renPath, ...renRest] = actionArgs;
		return runWorkspaceRename(renWorkspaceId, renPath, renRest);
	},
};
