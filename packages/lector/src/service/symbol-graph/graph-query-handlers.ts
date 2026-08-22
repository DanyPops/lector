import { boundListFromStart, jsonByteSize } from "../../bounds/bound-list.ts";
import type { SymbolGraphPort, SymbolNode } from "../../symbol-graph/port.ts";
import { reachableSymbolsFrom } from "../../symbol-graph/reachable-symbols-from.ts";
import { symbolEdgesFrom } from "../../symbol-graph/symbol-edges-from.ts";
import { symbolEdgesTo } from "../../symbol-graph/symbol-edges-to.ts";
import { deriveSymbolNodeId } from "../../symbol-graph/symbol-node-id.ts";
import { DEFAULT_GRAPH_QUERY_BYTES, DEFAULT_GRAPH_QUERY_RESULTS, MAX_GRAPH_QUERY_BYTES, MAX_GRAPH_QUERY_RESULTS, resolveBound } from "../bounds.ts";
import { AutoPopulateRequiresBounds, type WorkspaceId } from "../errors.ts";
import type { OperationInputs, OperationOutputs } from "../operations.ts";
import type { MutableRegistry } from "../workspace-registry.ts";

export interface GraphQueryHandlerDeps {
	readonly ensureSymbolGraph: (workspaceId: WorkspaceId) => SymbolGraphPort;
	readonly cacheStatus: (registry: MutableRegistry, input: OperationInputs["workspace.cacheStatus"]) => Promise<OperationOutputs["workspace.cacheStatus"]>;
	readonly populateSymbolGraph: (
		registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	) => Promise<OperationOutputs["workspace.populateSymbolGraph"]>;
}

export interface GraphQueryHandlers {
	"workspace.reachableFrom": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.reachableFrom"],
	) => Promise<OperationOutputs["workspace.reachableFrom"]>;
	"workspace.symbolEdgesFrom": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesFrom"],
	) => Promise<OperationOutputs["workspace.symbolEdgesFrom"]>;
	"workspace.symbolEdgesTo": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesTo"],
	) => Promise<OperationOutputs["workspace.symbolEdgesTo"]>;
}

/** Pure graph reads -- reachableFrom/symbolEdgesFrom/symbolEdgesTo need nothing but the graph itself, no warm index, no registry entry, no cache-freshness concern (autoPopulate opts into the one exception for reachableFrom). */
export function createGraphQueryHandlers(deps: GraphQueryHandlerDeps): GraphQueryHandlers {
	const { ensureSymbolGraph, cacheStatus, populateSymbolGraph } = deps;

	function boundedSymbolNodes(symbols: readonly SymbolNode[], input: { maxResults?: number; maxBytes?: number }): OperationOutputs["workspace.reachableFrom"] {
		const maxResults = resolveBound(input.maxResults, DEFAULT_GRAPH_QUERY_RESULTS, MAX_GRAPH_QUERY_RESULTS, "maxResults");
		const maxBytes = resolveBound(input.maxBytes, DEFAULT_GRAPH_QUERY_BYTES, MAX_GRAPH_QUERY_BYTES, "maxBytes");
		const { page, truncated } = boundListFromStart(symbols, maxResults, maxBytes, jsonByteSize);
		return { symbols: page, truncated };
	}

	async function reachableFromHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.reachableFrom"],
	): Promise<OperationOutputs["workspace.reachableFrom"]> {
		if (input.autoPopulate) {
			if (input.maxFiles === undefined || input.maxSymbolsPerFile === undefined) throw new AutoPopulateRequiresBounds("workspace.reachableFrom");
			const { maxFiles, maxSymbolsPerFile } = input;
			// Only "not-cached" (no completed generation at these bounds at all -- never present, or
			// recorded at different bounds) is safe to recover from automatically. "partial" (real
			// per-file population failures) and "caching"/"waiting-for-resources" (another population
			// already in flight) are never retried here regardless of this flag -- see
			// workspace.referenceBasedRename's own autoPopulate doc comment for why.
			const status = await cacheStatus(registry, { workspaceId: input.workspaceId, maxFiles, maxSymbolsPerFile });
			if (status.status === "not-cached") await populateSymbolGraph(registry, { workspaceId: input.workspaceId, maxFiles, maxSymbolsPerFile });
		}
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await reachableSymbolsFrom(graph, id, { maxDepth: input.maxDepth, kind: input.kind });
		return boundedSymbolNodes(symbols, input);
	}

	async function symbolEdgesFromHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesFrom"],
	): Promise<OperationOutputs["workspace.symbolEdgesFrom"]> {
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await symbolEdgesFrom(graph, id, input.kind);
		return boundedSymbolNodes(symbols, input);
	}

	async function symbolEdgesToHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesTo"],
	): Promise<OperationOutputs["workspace.symbolEdgesTo"]> {
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await symbolEdgesTo(graph, id, input.kind);
		return boundedSymbolNodes(symbols, input);
	}

	return {
		"workspace.reachableFrom": reachableFromHandler,
		"workspace.symbolEdgesFrom": symbolEdgesFromHandler,
		"workspace.symbolEdgesTo": symbolEdgesToHandler,
	};
}
