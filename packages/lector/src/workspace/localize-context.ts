import { truncateUtf8 } from "../bounds/truncate-utf8.ts";
import type { SymbolAnnotationPort } from "../symbol-annotation/port.ts";
import type { SymbolEdgeKind, SymbolGraphPort, SymbolNode } from "../symbol-graph/port.ts";
import type { SymbolNodeId } from "../symbol-graph/symbol-node-id.ts";
import type { TextSearchPort } from "../text-search/port.ts";
import type { TextSearchMatch } from "../text-search/text-search-result.ts";
import type { WorkspacePort } from "./port.ts";

const EDGE_KINDS: readonly SymbolEdgeKind[] = ["calls", "references", "contains"];
const STOP_WORDS = new Set([
	"after",
	"another",
	"appearing",
	"before",
	"build",
	"change",
	"code",
	"does",
	"file",
	"find",
	"fix",
	"from",
	"into",
	"issue",
	"make",
	"other",
	"session",
	"that",
	"the",
	"this",
	"when",
	"where",
	"with",
]);

export type ContextReasonKind = "seed-symbol" | "symbol-name" | "lexical-content" | "annotation" | "path" | "graph-edge";

export interface ContextReason {
	readonly kind: ContextReasonKind;
	readonly detail: string;
	readonly score: number;
}

export interface ContextCandidate {
	readonly name: string;
	readonly kind: string;
	readonly role: "production" | "test" | "configuration";
	readonly path: string;
	readonly line: number;
	readonly character: number;
	readonly signature?: string;
	readonly score: number;
	readonly reasons: readonly ContextReason[];
}

export interface ContextBundleCompleteness {
	readonly lexical: "complete" | "truncated" | "unavailable";
	readonly graph: "complete" | "bounded" | "unavailable";
	readonly deadlineReached: boolean;
	readonly candidateLimitReached: boolean;
}

export interface ContextBundleResult {
	readonly queryTerms: readonly string[];
	readonly candidates: readonly ContextCandidate[];
	readonly totalCandidates: number;
	readonly truncated: boolean;
	readonly completeness: ContextBundleCompleteness;
}

export interface LocalizeContextOptions {
	readonly maxSymbols: number;
	readonly maxBytes: number;
	readonly maxDepth: number;
	readonly maxGraphNodes: number;
	readonly maxLexicalMatches: number;
	readonly deadlineMs: number;
	readonly seedSymbols?: readonly string[];
	readonly seedLocations?: readonly { path: string; line: number; character?: number }[];
	readonly annotations?: SymbolAnnotationPort;
}

interface MutableCandidate {
	readonly node: SymbolNode;
	score: number;
	readonly reasons: ContextReason[];
}

function extractQueryTerms(query: string): string[] {
	return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_$-]+/gu) ?? [])]
		.filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
		.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addReason(candidate: MutableCandidate, reason: ContextReason): void {
	if (candidate.reasons.some((existing) => existing.kind === reason.kind && existing.detail === reason.detail)) return;
	candidate.reasons.push(reason);
	candidate.score += reason.score;
}

function pathLooksLikeTest(path: string): boolean {
	return /(^|[/\\])(?:test|tests|__tests__|fixtures)(?:[/\\]|$)|\.(?:test|spec)\.[^.]+$/i.test(path);
}

function candidateRole(path: string): ContextCandidate["role"] {
	if (pathLooksLikeTest(path)) return "test";
	if (/(^|[/\\])(?:package\.json|tsconfig[^/\\]*\.json|Cargo\.toml|go\.mod|pyproject\.toml|[^/\\]+\.config\.[^/\\]+)$/i.test(path)) return "configuration";
	return "production";
}

function lexicalReasonFor(node: SymbolNode, matchesByPath: ReadonlyMap<string, readonly TextSearchMatch[]>): ContextReason | undefined {
	const matches = matchesByPath.get(node.location.path);
	if (!matches || matches.length === 0) return undefined;
	const lines = matches
		.slice(0, 3)
		.map((match) => match.lineNumber)
		.join(", ");
	return { kind: "lexical-content", detail: `query terms matched this file at line${matches.length === 1 ? "" : "s"} ${lines}`, score: 12 };
}

async function attachSignature(workspace: WorkspacePort, candidate: MutableCandidate): Promise<ContextCandidate> {
	let signature: string | undefined;
	try {
		const entry = await workspace.readEntry(candidate.node.location.path);
		if (entry.exists) {
			const sourceLine = entry.content.split("\n")[candidate.node.location.line - 1]?.trim();
			if (sourceLine) signature = truncateUtf8(sourceLine, 2_048).value;
		}
	} catch {
		// A file may disappear after graph population. The declaration and its provenance remain useful.
	}
	return {
		name: candidate.node.name,
		kind: candidate.node.kind,
		role: candidateRole(candidate.node.location.path),
		path: candidate.node.location.path,
		line: candidate.node.location.line,
		character: candidate.node.location.character,
		...(signature ? { signature } : {}),
		score: candidate.score,
		reasons: [...candidate.reasons].sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.detail.localeCompare(b.detail)),
	};
}

/**
 * Deterministic, LLM-free task localization over lexical matches plus the persisted symbol graph.
 * Every score contribution is returned as provenance; all graph expansion, output, and wall-clock
 * work is bounded by caller values validated at the service boundary.
 */
export async function localizeContext(
	query: string,
	workspace: WorkspacePort,
	textSearch: TextSearchPort,
	graph: SymbolGraphPort,
	options: LocalizeContextOptions,
): Promise<ContextBundleResult> {
	const terms = extractQueryTerms(query);
	const startedAt = Date.now();
	const deadlineSignal = AbortSignal.timeout(options.deadlineMs);
	const deadlineReached = () => deadlineSignal.aborted || Date.now() - startedAt >= options.deadlineMs;
	let lexical: ContextBundleCompleteness["lexical"] = "complete";
	let matches: readonly TextSearchMatch[] = [];
	if (terms.length > 0) {
		try {
			const result = await textSearch.search(workspace.resolvePath("."), `(?i)(?:${terms.map(escapeRegex).join("|")})`, {
				maxMatches: options.maxLexicalMatches,
				maxBytes: Math.max(1, Math.floor(options.maxBytes / 2)),
				signal: deadlineSignal,
			});
			matches = result.matches;
			lexical = result.truncated ? "truncated" : "complete";
		} catch {
			lexical = "unavailable";
		}
	}

	const matchesByPath = new Map<string, TextSearchMatch[]>();
	for (const match of matches) {
		const resolvedPath = workspace.resolvePath(match.path);
		const existing = matchesByPath.get(resolvedPath) ?? [];
		existing.push(match);
		matchesByPath.set(resolvedPath, existing);
	}

	const annotationReasons = new Map<SymbolNodeId, ContextReason[]>();
	if (options.annotations && !deadlineReached()) {
		const seenAnnotations = new Set<string>();
		for (const term of terms) {
			if (deadlineReached()) break;
			for (const annotation of await options.annotations.list({ query: term, maxResults: options.maxSymbols * 2 })) {
				if (seenAnnotations.has(annotation.id)) continue;
				seenAnnotations.add(annotation.id);
				for (const anchor of annotation.anchors) {
					const reasons = annotationReasons.get(anchor.symbolNodeId) ?? [];
					reasons.push({
						kind: "annotation",
						detail: `${annotation.status} ${annotation.subtype} annotation matched: ${truncateUtf8(annotation.title, 256).value}`,
						score: annotation.status === "fresh" ? 16 : 8,
					});
					annotationReasons.set(anchor.symbolNodeId, reasons);
				}
			}
		}
	}

	const nodes = await graph.allNodes(options.maxGraphNodes);
	const graphGeneration = await graph.getGeneration();
	const candidates = new Map<SymbolNodeId, MutableCandidate>();
	const normalizedSeeds = new Set((options.seedSymbols ?? []).map((seed) => seed.toLowerCase()));
	const seedLocations = (options.seedLocations ?? []).map((seed) => ({ ...seed, path: workspace.resolvePath(seed.path) }));
	for (const node of nodes) {
		if (deadlineReached()) break;
		const candidate: MutableCandidate = { node, score: 0, reasons: [] };
		const normalizedName = node.name.toLowerCase();
		if (normalizedSeeds.has(normalizedName)) addReason(candidate, { kind: "seed-symbol", detail: `explicit seed symbol: ${node.name}`, score: 40 });
		if (
			seedLocations.some(
				(seed) =>
					seed.path === node.location.path && seed.line === node.location.line && (seed.character === undefined || seed.character === node.location.character),
			)
		) {
			addReason(candidate, { kind: "seed-symbol", detail: `explicit seed location: ${node.location.path}:${node.location.line}`, score: 40 });
		}
		for (const term of terms) {
			if (normalizedName === term) addReason(candidate, { kind: "symbol-name", detail: `exact symbol-name match: ${term}`, score: 24 });
			else if (normalizedName.includes(term)) addReason(candidate, { kind: "symbol-name", detail: `symbol name contains: ${term}`, score: 14 });
			if (node.location.path.toLowerCase().includes(term)) addReason(candidate, { kind: "path", detail: `path contains: ${term}`, score: 5 });
		}
		const lexicalReason = lexicalReasonFor(node, matchesByPath);
		if (lexicalReason) addReason(candidate, lexicalReason);
		for (const annotationReason of annotationReasons.get(node.id) ?? []) addReason(candidate, annotationReason);
		if (candidate.score > 0) {
			if (!pathLooksLikeTest(node.location.path)) candidate.score += 1;
			candidates.set(node.id, candidate);
		}
	}

	let frontier = [...candidates.values()]
		.sort((a, b) => b.score - a.score || a.node.location.path.localeCompare(b.node.location.path) || a.node.id.localeCompare(b.node.id))
		.slice(0, options.maxSymbols)
		.map((candidate) => candidate.node.id);
	const visited = new Set(frontier);
	for (let depth = 1; depth <= options.maxDepth && frontier.length > 0 && !deadlineReached(); depth++) {
		const next: SymbolNodeId[] = [];
		for (const sourceId of frontier) {
			if (deadlineReached() || visited.size >= options.maxGraphNodes) break;
			const source = await graph.getNode(sourceId);
			if (!source) continue;
			for (const edgeKind of EDGE_KINDS) {
				for (const direction of ["out", "in"] as const) {
					const neighborIds = direction === "out" ? await graph.edgesFrom(sourceId, edgeKind) : await graph.edgesTo(sourceId, edgeKind);
					for (const neighborId of neighborIds) {
						if (visited.size >= options.maxGraphNodes) break;
						const neighbor = await graph.getNode(neighborId);
						if (!neighbor) continue;
						let candidate = candidates.get(neighborId);
						if (!candidate) {
							candidate = { node: neighbor, score: 0, reasons: [] };
							candidates.set(neighborId, candidate);
						}
						const arrow = direction === "out" ? `${source.name} -> ${neighbor.name}` : `${neighbor.name} -> ${source.name}`;
						addReason(candidate, { kind: "graph-edge", detail: `${edgeKind} edge at depth ${depth}: ${arrow}`, score: Math.max(2, 9 - depth * 2) });
						if (!visited.has(neighborId)) {
							visited.add(neighborId);
							next.push(neighborId);
						}
					}
				}
			}
		}
		frontier = next;
	}

	const rankedSymbols = [...candidates.values()].sort(
		(a, b) =>
			b.score - a.score ||
			Number(pathLooksLikeTest(a.node.location.path)) - Number(pathLooksLikeTest(b.node.location.path)) ||
			a.node.location.path.localeCompare(b.node.location.path) ||
			a.node.location.line - b.node.location.line ||
			a.node.id.localeCompare(b.node.id),
	);
	const rankedItems: ContextCandidate[] = [];
	for (const candidate of rankedSymbols) {
		if (deadlineReached()) break;
		rankedItems.push(await attachSignature(workspace, candidate));
	}
	const symbolPaths = new Set(nodes.map((node) => node.location.path));
	for (const [path, pathMatches] of matchesByPath) {
		if (symbolPaths.has(path)) continue;
		const first = pathMatches[0];
		if (!first) continue;
		const pathReasons = terms
			.filter((term) => path.toLowerCase().includes(term))
			.map((term): ContextReason => ({ kind: "path", detail: `path contains: ${term}`, score: 5 }));
		const reasons: ContextReason[] = [
			{ kind: "lexical-content", detail: `query terms matched this file at line ${first.lineNumber}`, score: 12 },
			...pathReasons,
		];
		rankedItems.push({
			name: path,
			kind: "file",
			role: candidateRole(path),
			path,
			line: first.lineNumber,
			character: (first.lineStartByte ?? 0) + first.matchStart + 1,
			signature: truncateUtf8(first.line.trim(), 2_048).value,
			score: reasons.reduce((total, reason) => total + reason.score, 0),
			reasons,
		});
	}
	rankedItems.sort(
		(a, b) =>
			b.score - a.score ||
			Number(a.role === "test") - Number(b.role === "test") ||
			a.path.localeCompare(b.path) ||
			a.line - b.line ||
			a.name.localeCompare(b.name),
	);
	const output: ContextCandidate[] = [];
	let bytes = 0;
	for (const item of rankedItems) {
		if (output.length >= options.maxSymbols || deadlineReached()) break;
		const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
		if (itemBytes > options.maxBytes - bytes) continue;
		output.push(item);
		bytes += itemBytes;
	}
	const reachedDeadline = deadlineReached();
	const candidateLimitReached = nodes.length >= options.maxGraphNodes || visited.size >= options.maxGraphNodes;
	const graphBounded = candidateLimitReached || graphGeneration?.result.completeness !== "complete";
	return {
		queryTerms: terms,
		candidates: output,
		totalCandidates: rankedItems.length,
		truncated: output.length < rankedItems.length || reachedDeadline,
		completeness: {
			lexical,
			graph: graphGeneration === undefined ? "unavailable" : graphBounded ? "bounded" : "complete",
			deadlineReached: reachedDeadline,
			candidateLimitReached,
		},
	};
}
