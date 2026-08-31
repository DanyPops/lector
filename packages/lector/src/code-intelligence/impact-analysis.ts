import { resolve } from "node:path";
import type { Diagnostic } from "../code-intelligence/diagnostic.ts";
import type { IntelligenceProvenance } from "../code-intelligence/intelligence-provenance.ts";
import type { GitDiffFile, GitDiffFileStatus } from "../git/unified-diff.ts";
import type { SymbolEdgeKind, SymbolGraphPort, SymbolNode } from "../symbol-graph/port.ts";
import type { SymbolNodeId } from "../symbol-graph/symbol-node-id.ts";

export type ImpactEvidence =
	| { readonly kind: "semantic-edge"; readonly depth: number; readonly edgeKind?: SymbolEdgeKind }
	| { readonly kind: "type-hierarchy"; readonly depth: 1; readonly relation: "supertype" | "subtype" };

export interface ChangedSymbolEvidence {
	readonly symbol: SymbolNode;
	readonly side: "before" | "after";
	readonly status: GitDiffFileStatus;
}

export interface ImpactedSymbolEvidence {
	readonly symbol: SymbolNode;
	readonly depth: number;
	readonly evidence: ImpactEvidence;
}

export type TestAssociationEvidence =
	| ImpactEvidence
	| { readonly kind: "coverage"; readonly changedPath: string }
	| { readonly kind: "import-heuristic"; readonly changedPath: string }
	| { readonly kind: "filename-heuristic"; readonly changedPath: string };

export interface RelatedTestEvidence {
	readonly symbol: SymbolNode;
	readonly evidence: TestAssociationEvidence;
}

export interface ImpactPackageBoundary {
	readonly path: string;
	readonly marker: string;
	readonly changedPaths: readonly string[];
}

export interface ImpactDiagnosticSet {
	readonly path: string;
	readonly diagnostics: readonly Diagnostic[];
	readonly unavailable: boolean;
}

export interface ChangedSymbolImpactResult {
	readonly changedSymbols: readonly ChangedSymbolEvidence[];
	readonly impactedSymbols: readonly ImpactedSymbolEvidence[];
	readonly relatedTests: readonly RelatedTestEvidence[];
	readonly truncated: boolean;
	readonly deadlineReached: boolean;
}

export interface ImpactAnalysisResult extends ChangedSymbolImpactResult {
	readonly source: { readonly kind: "git"; readonly ref: string } | { readonly kind: "mutation"; readonly transactionId: string };
	readonly sourceCompleteness: "complete" | "truncated";
	readonly graph: { readonly completeness: "complete"; readonly provenance?: IntelligenceProvenance };
	readonly identityCompleteness: "complete" | "partial";
	readonly packageBoundaries: readonly ImpactPackageBoundary[];
	readonly diagnostics: readonly ImpactDiagnosticSet[];
}

export interface ChangedSymbolImpactOptions {
	readonly rootPath: string;
	readonly maxDepth: number;
	readonly maxNodes: number;
	readonly maxEdges: number;
	readonly deadlineMs: number;
}

function isTestPath(path: string): boolean {
	return /(^|[/\\])(?:test|tests|__tests__)(?:[/\\]|$)|\.(?:test|spec)\.[^.]+$/i.test(path);
}

function changedLines(file: GitDiffFile, side: "before" | "after"): ReadonlySet<number> | undefined {
	if (file.hunks.length === 0) return undefined;
	const lines = new Set<number>();
	for (const hunk of file.hunks) {
		const start = side === "before" ? hunk.oldStart : hunk.newStart;
		const count = side === "before" ? hunk.oldLines : hunk.newLines;
		for (let offset = 0; offset < count; offset += 1) lines.add(start + offset);
	}
	return lines;
}

function compareNodes(left: SymbolNode, right: SymbolNode): number {
	return (
		left.location.path.localeCompare(right.location.path) || left.location.line - right.location.line || left.location.character - right.location.character
	);
}

/** Computes a bounded reverse semantic impact cone from declarations intersecting changed diff ranges. */
export async function changedSymbolImpact(
	graph: SymbolGraphPort,
	files: readonly GitDiffFile[],
	options: ChangedSymbolImpactOptions,
): Promise<ChangedSymbolImpactResult> {
	const startedAt = Date.now();
	const deadlineReached = () => Date.now() - startedAt >= options.deadlineMs;
	const paths = [
		...new Set(files.flatMap((file) => [resolve(options.rootPath, file.path), ...(file.previousPath ? [resolve(options.rootPath, file.previousPath)] : [])])),
	];
	const candidates = await graph.nodesForFiles(paths, options.maxNodes);
	const changedSymbols: ChangedSymbolEvidence[] = [];
	for (const file of files) {
		const afterPath = resolve(options.rootPath, file.path);
		const beforePath = resolve(options.rootPath, file.previousPath ?? file.path);
		const sides: readonly ("before" | "after")[] = file.status === "renamed" ? ["before", "after"] : file.status === "deleted" ? ["before"] : ["after"];
		for (const side of sides) {
			const path = side === "before" ? beforePath : afterPath;
			const lines = changedLines(file, side);
			const declarations = candidates.filter((symbol) => symbol.location.path === path).sort(compareNodes);
			const matched = new Set<SymbolNodeId>();
			if (!lines) {
				for (const symbol of declarations) matched.add(symbol.id);
			} else {
				for (const line of lines) {
					const containing = declarations.filter((symbol) => symbol.location.line <= line).at(-1);
					if (containing) matched.add(containing.id);
				}
			}
			for (const symbol of declarations) {
				if (matched.has(symbol.id)) changedSymbols.push({ symbol, side, status: file.status });
			}
		}
	}
	changedSymbols.sort((left, right) => compareNodes(left.symbol, right.symbol));

	const nodes = await graph.allNodes(options.maxNodes);
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const edges = await graph.allEdges(options.maxEdges);
	const incoming = new Map<SymbolNodeId, { id: SymbolNodeId; kind: SymbolEdgeKind }[]>();
	for (const edge of edges) {
		const list = incoming.get(edge.to) ?? [];
		list.push({ id: edge.from, kind: edge.kind });
		incoming.set(edge.to, list);
	}
	for (const list of incoming.values()) list.sort((left, right) => left.id.localeCompare(right.id));

	const changedIds = new Set(changedSymbols.map(({ symbol }) => symbol.id));
	const visited = new Set(changedIds);
	let frontier = [...changedIds];
	const impactedSymbols: ImpactedSymbolEvidence[] = [];
	for (let depth = 1; depth <= options.maxDepth && frontier.length > 0 && !deadlineReached(); depth += 1) {
		const next: SymbolNodeId[] = [];
		for (const target of frontier) {
			for (const edge of incoming.get(target) ?? []) {
				if (visited.has(edge.id) || impactedSymbols.length >= options.maxNodes) continue;
				visited.add(edge.id);
				const symbol = nodeById.get(edge.id);
				if (!symbol) continue;
				impactedSymbols.push({ symbol, depth, evidence: { kind: "semantic-edge", depth, edgeKind: edge.kind } });
				next.push(edge.id);
			}
		}
		frontier = next;
	}
	impactedSymbols.sort((left, right) => left.depth - right.depth || compareNodes(left.symbol, right.symbol));
	const relatedTests = impactedSymbols.flatMap(({ symbol, evidence }) =>
		isTestPath(symbol.location.path) && evidence.kind === "semantic-edge"
			? [{ symbol, evidence: { kind: "semantic-edge" as const, depth: evidence.depth } }]
			: [],
	);
	return {
		changedSymbols,
		impactedSymbols,
		relatedTests,
		truncated:
			candidates.length >= options.maxNodes ||
			nodes.length >= options.maxNodes ||
			edges.length >= options.maxEdges ||
			impactedSymbols.length >= options.maxNodes,
		deadlineReached: deadlineReached(),
	};
}
