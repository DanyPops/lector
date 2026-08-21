import { dirname, isAbsolute, join, relative, sep } from "node:path";
import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank";
import { descriptorForPath } from "../code-intelligence/language-server-descriptor.ts";
import type { SymbolGraphPort, SymbolNode } from "../symbol-graph/port.ts";
import type { SymbolNodeId } from "../symbol-graph/symbol-node-id.ts";
import { pathHasSkippedDirectorySegment } from "../text-search/skip-directories.ts";
import type { WorkspacePort } from "./port.ts";

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

export interface WorkspaceMapCandidateSelection {
	readonly strategy: "generation-stratified" | "bounded-prefix";
	readonly representedLanguages: readonly string[];
	readonly omittedLanguages: readonly string[];
	/** Language-qualified declared project roots, relative to the registered workspace root. */
	readonly representedScopes: readonly string[];
	readonly omittedScopes: readonly string[];
	/** True when maxNodes was fully consumed, so additional declarations may exist in represented scopes. */
	readonly candidateLimitReached: boolean;
}

export interface WorkspaceMapResult {
	readonly entries: readonly WorkspaceMapEntry[];
	/** How many nodes were ranked before maxEntries/maxBytes truncation -- lets a caller distinguish "this is everything" from "this is the top slice". */
	readonly totalRanked: number;
	readonly truncated: boolean;
	readonly candidateSelection: WorkspaceMapCandidateSelection;
}

interface CandidateGroup {
	readonly languageId: string;
	readonly scope: string;
	readonly paths: string[];
}

function isContained(root: string, path: string): boolean {
	const projected = relative(root, path);
	return projected === "" || (projected !== ".." && !projected.startsWith(`..${sep}`) && !isAbsolute(projected));
}

function isLowValuePath(path: string): boolean {
	return /(^|[/\\])(?:test|tests|__tests__|fixtures)(?:[/\\]|$)|\.(?:test|spec)\.[^.]+$/i.test(path);
}

async function classifyCandidatePath(
	workspace: WorkspacePort,
	path: string,
	markerCache: Map<string, boolean>,
): Promise<{ languageId: string; scope: string }> {
	const canonical = workspace.resolvePath(path);
	const root = workspace.resolvePath(".");
	const descriptor = descriptorForPath(canonical);
	const languageId = descriptor?.languageId ?? "unknown";
	let directory = dirname(canonical);
	while (isContained(root, directory)) {
		for (const marker of descriptor?.rootMarkers ?? []) {
			const markerPath = join(directory, marker);
			let exists = markerCache.get(markerPath);
			if (exists === undefined) {
				try {
					exists = (await workspace.readEntry(markerPath)).exists;
				} catch {
					exists = false;
				}
				markerCache.set(markerPath, exists);
			}
			if (exists) return { languageId, scope: relative(root, directory) || "." };
		}
		if (directory === root) break;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	const projected = relative(root, canonical);
	const firstSegment = projected.split(sep).filter(Boolean)[0];
	return { languageId, scope: firstSegment ?? "." };
}

async function selectWorkspaceMapCandidates(
	graph: SymbolGraphPort,
	workspace: WorkspacePort,
	maxNodes: number,
): Promise<{ nodes: readonly SymbolNode[]; metadata: WorkspaceMapCandidateSelection }> {
	const generation = await graph.getGeneration();
	if (!generation?.walkedFiles || generation.walkedFiles.length === 0) {
		const nodes = (await graph.allNodes(maxNodes)).filter((node) => {
			if (pathHasSkippedDirectorySegment(node.location.path)) return false;
			try {
				workspace.resolvePath(node.location.path);
				return true;
			} catch {
				return false;
			}
		});
		return {
			nodes,
			metadata: {
				strategy: "bounded-prefix",
				representedLanguages: [],
				omittedLanguages: [],
				representedScopes: [],
				omittedScopes: [],
				candidateLimitReached: nodes.length === maxNodes,
			},
		};
	}

	const markerCache = new Map<string, boolean>();
	const groupsByKey = new Map<string, CandidateGroup>();
	for (const path of [...generation.walkedFiles].sort()) {
		if (pathHasSkippedDirectorySegment(path)) continue;
		let classification: { languageId: string; scope: string };
		try {
			classification = await classifyCandidatePath(workspace, path, markerCache);
		} catch {
			continue;
		}
		const key = `${classification.languageId}:${classification.scope}`;
		const group = groupsByKey.get(key) ?? { ...classification, paths: [] };
		group.paths.push(path);
		groupsByKey.set(key, group);
	}
	const groups = [...groupsByKey.values()].sort((a, b) => a.languageId.localeCompare(b.languageId) || a.scope.localeCompare(b.scope));
	for (const group of groups) group.paths.sort((a, b) => Number(isLowValuePath(a)) - Number(isLowValuePath(b)) || a.localeCompare(b));

	const selectedByGroup = new Map<CandidateGroup, SymbolNode[]>();
	let remaining = maxNodes;
	for (let index = 0; index < groups.length && remaining > 0; index++) {
		const group = groups[index];
		if (!group) continue;
		const quota = Math.max(1, Math.floor(remaining / (groups.length - index)));
		const nodes = [...(await graph.nodesForFiles(group.paths, quota))];
		selectedByGroup.set(group, nodes);
		remaining -= nodes.length;
	}
	// Empty/sparse groups can leave quota unused. Redistribute it only after every group had a
	// chance to contribute, preserving representation before depth within any one scope.
	for (const group of groups) {
		if (remaining <= 0) break;
		const selected = selectedByGroup.get(group) ?? [];
		const expanded = await graph.nodesForFiles(group.paths, selected.length + remaining);
		const extras = expanded.slice(selected.length, selected.length + remaining);
		selected.push(...extras);
		selectedByGroup.set(group, selected);
		remaining -= extras.length;
	}

	const nodes = groups.flatMap((group) => selectedByGroup.get(group) ?? []).slice(0, maxNodes);
	const representedGroups = groups.filter((group) => (selectedByGroup.get(group)?.length ?? 0) > 0);
	const omittedGroups = groups.filter((group) => (selectedByGroup.get(group)?.length ?? 0) === 0);
	const representedLanguages = [...new Set(representedGroups.map((group) => group.languageId))].sort();
	const allLanguages = [...new Set(groups.map((group) => group.languageId))].sort();
	return {
		nodes,
		metadata: {
			strategy: "generation-stratified",
			representedLanguages,
			omittedLanguages: allLanguages.filter((language) => !representedLanguages.includes(language)),
			representedScopes: representedGroups.map((group) => `${group.languageId}:${group.scope}`),
			omittedScopes: omittedGroups.map((group) => `${group.languageId}:${group.scope}`),
			candidateLimitReached: nodes.length === maxNodes,
		},
	};
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
	const selection = await selectWorkspaceMapCandidates(graph, workspace, options.maxNodes);
	const nodes = selection.nodes;
	if (nodes.length === 0) return { entries: [], totalRanked: 0, truncated: false, candidateSelection: selection.metadata };
	const edges = await graph.edgesAmong(
		nodes.map((node) => node.id),
		options.maxEdges,
	);

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
		// graphology's own node keys are untyped strings by design; every key here was seeded from a
		// real SymbolNodeId via mergeNode(node.id) above.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		.map((id) => ({ node: nodeById.get(id as SymbolNodeId), score: scores[id] ?? 0 }))
		.filter((entry): entry is { node: SymbolNode; score: number } => entry.node !== undefined)
		.sort(
			(a, b) =>
				b.score - a.score ||
				a.node.location.path.localeCompare(b.node.location.path) ||
				a.node.location.line - b.node.location.line ||
				a.node.location.character - b.node.location.character ||
				a.node.id.localeCompare(b.node.id),
		);

	const linesByPath = new Map<string, readonly string[] | undefined>();
	const entries: WorkspaceMapEntry[] = [];
	let usedBytes = 0;
	for (const { node, score } of ranked) {
		if (entries.length >= options.maxEntries) break;
		if (!linesByPath.has(node.location.path)) {
			// Files can disappear or become unreadable after graph population; keep the ranked
			// declaration with no signature rather than failing the entire bounded overview.
			let lines: readonly string[] | undefined;
			try {
				const fileEntry = await workspace.readEntry(node.location.path);
				lines = fileEntry.exists ? fileEntry.content.split("\n") : undefined;
			} catch {
				lines = undefined;
			}
			linesByPath.set(node.location.path, lines);
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
	return {
		entries,
		totalRanked: ranked.length,
		truncated: entries.length < ranked.length || selection.metadata.candidateLimitReached || selection.metadata.omittedScopes.length > 0,
		candidateSelection: selection.metadata,
	};
}
