/**
 * Real, deterministic implementations of Lector's own distinct retrieval paths -- lexical
 * (search_code), symbol-name (find_symbols), graph (reachable_from-shaped traversal), and
 * annotation (symbol_annotations free-text search, the project's own already-decided "good
 * enough" local semantic layer, see the canceled embedding-search task's own reframing) -- for
 * the hybrid-retrieval benchmark (efe48de0/3cf2e918) to score against the ground-truth corpus.
 *
 * Every method reports its own retrieved file paths (`paths`, the identity every backend here
 * can express, including ripgrep's lexical search which has no concept of a symbol at all) plus,
 * where the backend genuinely knows a symbol's own name (symbol/graph, not lexical/annotation),
 * `symbolKeys` (`path#name`) for the finer-grained comparison. A caller scores both: file-level
 * recall uniformly across every method via scoreGroundTruthTaskByPath, symbol-level recall only
 * where `symbolKeys` is present via scoreGroundTruthTask.
 */

import type { SymbolIndexPort } from "../../src/code-intelligence/symbol-index-port.ts";
import type { SymbolAnnotationPort } from "../../src/symbol-annotation/port.ts";
import type { SymbolGraphPort } from "../../src/symbol-graph/port.ts";
import { deriveSymbolNodeId, type SymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";
import type { TextSearchPort } from "../../src/text-search/port.ts";
import { findWorkspaceSymbols } from "../../src/workspace/find-workspace-symbols.ts";

export interface RetrievedResult {
	readonly paths: readonly string[];
	/** `path#name` keys -- present only when the backend genuinely knows the symbol's own name. */
	readonly symbolKeys?: readonly string[];
}

function dedupe(items: readonly string[]): string[] {
	return [...new Set(items)];
}

function symbolKey(path: string, name: string): string {
	return `${path}#${name}`;
}

/**
 * Runs a real ripgrep-backed literal-text search. Returns the distinct file paths matched, in
 * the order ripgrep itself reported them -- exactly what search_code returns today, with no
 * relevance ranking beyond that, and no symbol identity (ripgrep matches lines, not symbols).
 */
export async function lexicalRetrieve(textSearch: TextSearchPort, root: string, query: string, maxResults: number): Promise<RetrievedResult> {
	const result = await textSearch.search(root, query, { maxMatches: 200, maxBytes: 64 * 1024 });
	return { paths: dedupe(result.matches.map((match) => match.path)).slice(0, maxResults) };
}

/** Runs a real LSP-backed workspace symbol search. Reports both the distinct file paths matched and the exact `path#name` symbol keys. */
export async function symbolRetrieve(index: SymbolIndexPort, query: string, maxResults: number): Promise<RetrievedResult> {
	const result = await findWorkspaceSymbols(index, query);
	const symbolKeys = dedupe(result.symbols.map((symbol) => symbolKey(symbol.location.path, symbol.name))).slice(0, maxResults);
	const paths = dedupe(result.symbols.map((symbol) => symbol.location.path)).slice(0, maxResults);
	return { paths, symbolKeys };
}

/**
 * Resolves a seed symbol by name, then explores the persisted graph in both directions
 * (`reachableFrom`'s own out-edges, plus a direct in-edge lookup via `edgesTo` for "what calls
 * this" questions `reachableFrom` alone cannot answer) up to `maxDepth` hops. This is a strictly
 * benchmark-local traversal -- it composes the real SymbolGraphPort surface without adding new
 * production API, matching what `reachable_from` plus `call_hierarchy(direction=incoming)` would
 * together answer for an agent asking a cross-file "who calls X" question.
 */
export async function graphRetrieve(
	index: SymbolIndexPort,
	graph: SymbolGraphPort,
	seedQuery: string,
	maxDepth: number,
	maxResults: number,
): Promise<RetrievedResult> {
	const seeds = await findWorkspaceSymbols(index, seedQuery);
	const symbolKeys: string[] = [];
	const paths: string[] = [];
	for (const seed of seeds.symbols) {
		const seedId = deriveSymbolNodeId(seed.location);
		symbolKeys.push(symbolKey(seed.location.path, seed.name));
		paths.push(seed.location.path);

		const outgoingIds = await graph.reachableFrom(seedId, { maxDepth });
		const incomingIds = await incomingReachableFrom(graph, seedId, maxDepth);
		const nodes = await Promise.all([...outgoingIds, ...incomingIds].map((id) => graph.getNode(id)));
		for (const node of nodes) {
			if (!node) continue;
			symbolKeys.push(symbolKey(node.location.path, node.name));
			paths.push(node.location.path);
		}
	}
	return { paths: dedupe(paths).slice(0, maxResults), symbolKeys: dedupe(symbolKeys).slice(0, maxResults) };
}

/** BFS over in-edges (`edgesTo`) -- the reverse of `reachableFrom`'s own out-edge traversal, since the port exposes no reversed variant directly. */
async function incomingReachableFrom(graph: SymbolGraphPort, id: SymbolNodeId, maxDepth: number): Promise<SymbolNodeId[]> {
	const visited = new Set<SymbolNodeId>([id]);
	let frontier: SymbolNodeId[] = [id];
	for (let depth = 0; depth < maxDepth; depth++) {
		const nextFrontier: SymbolNodeId[] = [];
		for (const current of frontier) {
			const callers = await graph.edgesTo(current);
			for (const caller of callers) {
				if (visited.has(caller)) continue;
				visited.add(caller);
				nextFrontier.push(caller);
			}
		}
		if (nextFrontier.length === 0) break;
		frontier = nextFrontier;
	}
	visited.delete(id);
	return [...visited];
}

/**
 * A hand-authored annotation to seed into the in-memory annotation store before running
 * `annotationRetrieve` -- simulating what a prior agent session would have left behind after
 * genuinely exploring and understanding this code, per Lector's own already-decided
 * "agent-authored narrative over raw embeddings" semantic-layer design (see the canceled
 * embedding-search task's reframing).
 */
export interface SeedAnnotation {
	readonly path: string;
	readonly symbolLocation: { readonly line: number; readonly character: number };
	readonly title: string;
	readonly body: string;
}

/** Free-text substring search over agent-authored annotation title/body -- the real SymbolAnnotationPort.list(query) surface, no reimplementation. No symbol identity: an anchor carries a path, not the symbol's own display name. */
export async function annotationRetrieve(annotations: SymbolAnnotationPort, query: string, maxResults: number): Promise<RetrievedResult> {
	const matches = await annotations.list({ query, maxResults });
	return { paths: dedupe(matches.flatMap((annotation) => annotation.anchors.map((anchor) => anchor.path))).slice(0, maxResults) };
}

/**
 * Union of every real method's own retrieved result -- a naive, no-new-infrastructure
 * rank-fusion prototype standing in for "combined/hybrid retrieval": exactly what an agent gets
 * today by simply trying more than one tool, with zero new backend. Preserves each input's own
 * relative order, concatenated in the order given.
 */
export function combinedRetrieve(...results: readonly RetrievedResult[]): RetrievedResult {
	const paths = dedupe(results.flatMap((result) => result.paths));
	const symbolKeySets = results.map((result) => result.symbolKeys).filter((keys): keys is readonly string[] => keys !== undefined);
	return symbolKeySets.length > 0 ? { paths, symbolKeys: dedupe(symbolKeySets.flat()) } : { paths };
}
