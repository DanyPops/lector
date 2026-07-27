import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank";
import type { SymbolGraphPort, SymbolNode } from "../ports/symbol-graph-port.ts";
import type { WorkspacePort } from "../ports/workspace-port.ts";
import { pathHasSkippedDirectorySegment } from "./skip-directories.ts";

export interface WorkspaceMapOptions {
	/** Bounds the raw fetch from the graph before ranking -- see SymbolGraphPort.allNodes/allEdges. */
	readonly maxNodes: number;
	readonly maxEdges: number;
	/** Hard cap on the number of ranked entries returned, independent of maxBytes. */
	readonly maxEntries: number;
	/** Soft budget: stops adding entries once exceeded, even under maxEntries. */
	readonly maxBytes: number;
}

export interface WorkspaceMapEntry {
	readonly name: string;
	readonly kind: string;
	readonly path: string;
	readonly line: number;
	readonly character: number;
	/** The exact current source line at this symbol's position -- conveys its call shape without its full body. Absent when the file could no longer be read (e.g. removed since the graph was populated). */
	readonly signature?: string;
	/** PageRank score over the workspace's call/reference graph -- higher means more central, not merely more frequently named. */
	readonly score: number;
}

export interface WorkspaceMapResult {
	readonly entries: readonly WorkspaceMapEntry[];
	/** How many nodes were ranked before maxEntries/maxBytes truncation -- lets a caller distinguish "this is everything" from "this is the top slice". */
	readonly totalRanked: number;
	readonly truncated: boolean;
}

/**
 * Ranks the workspace's persisted symbol graph by PageRank (graphology-metrics,
 * the same maintainer as graphology core already depended on for the graph
 * data structure itself -- not a hand-rolled centrality measure) and returns
 * a budget-bounded, signature-only slice, highest-ranked first. Mirrors
 * aider's own repo-map design: the most-referenced-by-important-things
 * symbols are the ones worth showing when the whole workspace can't fit in
 * context, not merely the most frequently named ones (plain in-degree would
 * miss the transitive effect of being called by something itself central).
 */
export async function computeWorkspaceMap(graph: SymbolGraphPort, workspace: WorkspacePort, options: WorkspaceMapOptions): Promise<WorkspaceMapResult> {
	const [allFetchedNodes, edges] = await Promise.all([graph.allNodes(options.maxNodes), graph.allEdges(options.maxEdges)]);
	// node_modules/vendored declarations reach the graph only as outgoingCalls edge targets
	// (the file scan itself never lists them) -- keep them in SymbolGraphPort for other features
	// that legitimately need them (reachable_from, incoming_calls), but excluding them from
	// ranking entirely: many unrelated call sites across a real codebase all point at the same
	// shared stdlib method, which would otherwise dominate PageRank and crowd out the workspace's
	// own architecturally-central symbols -- exactly the effect aider's own repo-map avoids by
	// scoping ranking to the project's own files.
	const nodes = allFetchedNodes.filter((node) => !pathHasSkippedDirectorySegment(node.location.path));
	if (nodes.length === 0) return { entries: [], totalRanked: 0, truncated: false };

	const rankGraph = new Graph({ type: "directed", multi: true, allowSelfLoops: true });
	for (const node of nodes) rankGraph.mergeNode(node.id);
	for (const edge of edges) {
		// An edge to/from a node outside the bounded fetch is skipped, not fabricated as a node.
		if (!rankGraph.hasNode(edge.from) || !rankGraph.hasNode(edge.to)) continue;
		if (!rankGraph.hasEdge(edge.from, edge.to)) rankGraph.mergeEdge(edge.from, edge.to);
	}
	const scores = pagerank(rankGraph);
	const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
	const ranked = rankGraph
		.nodes()
		.map((id) => ({ node: nodeById.get(id), score: scores[id] ?? 0 }))
		.filter((entry): entry is { node: SymbolNode; score: number } => entry.node !== undefined)
		.sort((a, b) => b.score - a.score);

	const linesByPath = new Map<string, readonly string[] | undefined>();
	const entries: WorkspaceMapEntry[] = [];
	let usedBytes = 0;
	for (const { node, score } of ranked) {
		if (entries.length >= options.maxEntries) break;
		if (!linesByPath.has(node.location.path)) {
			const fileEntry = await workspace.readEntry(node.location.path);
			linesByPath.set(node.location.path, fileEntry.exists ? fileEntry.content.split("\n") : undefined);
		}
		const signature = linesByPath.get(node.location.path)?.[node.location.line - 1]?.trim();
		const entry: WorkspaceMapEntry = {
			name: node.name,
			kind: node.kind,
			path: node.location.path,
			line: node.location.line,
			character: node.location.character,
			score,
			...(signature ? { signature } : {}),
		};
		const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf-8");
		if (usedBytes + entryBytes > options.maxBytes && entries.length > 0) break;
		entries.push(entry);
		usedBytes += entryBytes;
	}
	return { entries, totalRanked: ranked.length, truncated: entries.length < ranked.length };
}
