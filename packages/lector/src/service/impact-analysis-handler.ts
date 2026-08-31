import { basename, dirname, extname, join, relative } from "node:path";
import { jsonByteSize } from "../bounds/bound-list.ts";
import { diagnostics as diagnosticsQuery } from "../code-intelligence/diagnostics.ts";
import {
	type ChangedSymbolEvidence,
	changedSymbolImpact,
	type ImpactAnalysisResult,
	type ImpactedSymbolEvidence,
	type RelatedTestEvidence,
} from "../code-intelligence/impact-analysis.ts";
import type { GitPort } from "../git/port.ts";
import type { GitDiffFile } from "../git/unified-diff.ts";
import type { MutationHistoryEntry } from "../mutation-history/mutation-history.ts";
import type { SymbolGraphPort, SymbolNode } from "../symbol-graph/port.ts";
import { deriveSymbolNodeId } from "../symbol-graph/symbol-node-id.ts";
import { resolveBound } from "./bounds.ts";
import { requireCodeIntelligence } from "./code-intelligence-handlers.ts";
import type { WorkspaceId } from "./errors.ts";
import type { MutationHistoryCoordinator } from "./mutation-history-handlers.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import type { WarmIndexRegistry } from "./warm-index-registry.ts";
import { type MutableRegistry, resolveWorkspace } from "./workspace-registry.ts";

const DEFAULT_IMPACT_DEPTH = 2;
const MAX_IMPACT_DEPTH = 8;
const DEFAULT_IMPACT_NODES = 500;
const MAX_IMPACT_NODES = 20_000;
const DEFAULT_IMPACT_EDGES = 5_000;
const MAX_IMPACT_EDGES = 200_000;
const DEFAULT_IMPACT_BYTES = 256 * 1024;
const MAX_IMPACT_BYTES = 4 * 1024 * 1024;
const DEFAULT_IMPACT_DEADLINE_MS = 10_000;
const MAX_IMPACT_DEADLINE_MS = 120_000;
const MAX_SOURCE_ID_BYTES = 4_096;
const MAX_PACKAGE_ANCESTORS = 32;
const MAX_COVERAGE_TESTS = 1_000;
const MAX_COVERED_PATHS_PER_TEST = 1_000;
const MAX_COVERAGE_PATH_BYTES = 4_096;
const PACKAGE_MARKERS = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "Package.swift"] as const;

export interface ImpactAnalysisHandlerDeps {
	readonly graph: (workspaceId: WorkspaceId) => SymbolGraphPort;
	readonly createGitPort: (rootPath: string) => GitPort;
	readonly mutationHistory: MutationHistoryCoordinator;
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
	readonly cacheStatus: (registry: MutableRegistry, input: OperationInputs["workspace.cacheStatus"]) => Promise<OperationOutputs["workspace.cacheStatus"]>;
	readonly populateSymbolGraph: (
		registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	) => Promise<OperationOutputs["workspace.populateSymbolGraph"]>;
	readonly supertypes: (registry: MutableRegistry, input: OperationInputs["workspace.supertypes"]) => Promise<OperationOutputs["workspace.supertypes"]>;
	readonly subtypes: (registry: MutableRegistry, input: OperationInputs["workspace.subtypes"]) => Promise<OperationOutputs["workspace.subtypes"]>;
}

export class ImpactAnalysisRequiresFreshGraph extends Error {
	constructor(readonly status: string) {
		super(`impact analysis requires a complete current symbol graph; cache status is ${status}`);
		this.name = "ImpactAnalysisRequiresFreshGraph";
	}
}

function transactionFiles(entries: readonly MutationHistoryEntry[]): GitDiffFile[] {
	return entries.map((entry) => ({
		path: entry.path,
		status: entry.beforeContent === null ? "added" : entry.afterHash === null ? "deleted" : "modified",
		binary: false,
		hunks: [],
	}));
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function testNameKey(path: string): string {
	return basename(path, extname(path))
		.replace(/\.(?:test|spec)$/i, "")
		.replace(/[-_.]/g, "")
		.toLowerCase();
}

async function heuristicTests(
	workspace: ReturnType<typeof resolveWorkspace>,
	nodes: readonly SymbolNode[],
	changedPaths: readonly string[],
	existing: readonly RelatedTestEvidence[],
	coverage: OperationInputs["workspace.impactAnalysis"]["coverage"],
	deadlineReached: () => boolean,
): Promise<RelatedTestEvidence[]> {
	const known = new Set(existing.map(({ symbol }) => symbol.id));
	const keys = changedPaths.map((path) => ({ path, key: testNameKey(path), module: basename(path, extname(path)) })).filter(({ key }) => key.length > 0);
	const coverageByTest = new Map(
		(coverage ?? []).map((entry) => [workspace.resolvePath(entry.testPath), new Set(entry.coveredPaths.map((path) => workspace.resolvePath(path)))]),
	);
	const result: RelatedTestEvidence[] = [];
	for (const symbol of nodes) {
		if (deadlineReached()) break;
		if (!/(^|[/\\])(?:test|tests|__tests__)(?:[/\\]|$)|\.(?:test|spec)\.[^.]+$/i.test(symbol.location.path) || known.has(symbol.id)) continue;
		const coveredPath = changedPaths.find((path) => coverageByTest.get(symbol.location.path)?.has(path));
		if (coveredPath) {
			result.push({ symbol, evidence: { kind: "coverage", changedPath: coveredPath } });
			continue;
		}
		let content = "";
		try {
			const entry = await workspace.readEntry(symbol.location.path);
			if (entry.exists) content = entry.content;
		} catch {
			// A disappearing test file cannot contribute heuristic evidence.
		}
		const imported = keys.find(({ module }) =>
			new RegExp(`(?:from\\s+["'][^"']*${escapeRegex(module)}["']|require\\(["'][^"']*${escapeRegex(module)}["']\\))`).test(content),
		);
		if (imported) {
			result.push({ symbol, evidence: { kind: "import-heuristic", changedPath: imported.path } });
			continue;
		}
		const named = keys.find(({ key }) => testNameKey(symbol.location.path).includes(key));
		if (named) result.push({ symbol, evidence: { kind: "filename-heuristic", changedPath: named.path } });
	}
	return result.sort(
		(left, right) => left.symbol.location.path.localeCompare(right.symbol.location.path) || left.symbol.location.line - right.symbol.location.line,
	);
}

async function packageBoundary(workspace: ReturnType<typeof resolveWorkspace>, rootPath: string, path: string) {
	let current = dirname(path);
	for (let depth = 0; depth < MAX_PACKAGE_ANCESTORS; depth += 1) {
		for (const marker of PACKAGE_MARKERS) {
			if ((await workspace.readEntry(join(current, marker))).exists) return { path: current, marker };
		}
		if (current === rootPath || relative(rootPath, current).startsWith("..")) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function boundResult(result: ImpactAnalysisResult, maxBytes: number): ImpactAnalysisResult {
	const mutable = {
		...result,
		changedSymbols: [...result.changedSymbols],
		impactedSymbols: [...result.impactedSymbols],
		relatedTests: [...result.relatedTests],
		packageBoundaries: [...result.packageBoundaries],
		diagnostics: [...result.diagnostics],
	};
	let bounded = result.truncated;
	const lists = [mutable.diagnostics, mutable.relatedTests, mutable.impactedSymbols, mutable.packageBoundaries, mutable.changedSymbols];
	while (jsonByteSize(mutable) > maxBytes) {
		const list = lists.find((candidate) => candidate.length > 0);
		if (!list) throw new TypeError(`maxBytes ${maxBytes} is too small for impact-analysis metadata`);
		list.pop();
		bounded = true;
	}
	return { ...mutable, truncated: bounded };
}

export function createImpactAnalysisHandler(deps: ImpactAnalysisHandlerDeps) {
	return async (registry: MutableRegistry, input: OperationInputs["workspace.impactAnalysis"]): Promise<OperationOutputs["workspace.impactAnalysis"]> => {
		const sourceKind = String(input.source.kind);
		if (sourceKind !== "git" && sourceKind !== "mutation") throw new TypeError("impact source kind must be git or mutation");
		if (input.source.kind === "mutation" && input.source.transactionId.trim().length === 0) throw new TypeError("mutation transactionId must be non-empty");
		if (input.source.kind === "git" && input.source.ref !== undefined && input.source.ref.trim().length === 0)
			throw new TypeError("git ref must be non-empty when provided");
		const sourceId = input.source.kind === "git" ? (input.source.ref ?? "HEAD") : input.source.transactionId;
		if (Buffer.byteLength(sourceId, "utf8") > MAX_SOURCE_ID_BYTES) throw new TypeError(`impact source identifier must be at most ${MAX_SOURCE_ID_BYTES} bytes`);
		if ((input.coverage?.length ?? 0) > MAX_COVERAGE_TESTS) throw new TypeError(`coverage must contain no more than ${MAX_COVERAGE_TESTS} tests`);
		for (const entry of input.coverage ?? []) {
			if (entry.coveredPaths.length > MAX_COVERED_PATHS_PER_TEST)
				throw new TypeError(`coverage coveredPaths must contain no more than ${MAX_COVERED_PATHS_PER_TEST} paths per test`);
			if (Buffer.byteLength(entry.testPath, "utf8") > MAX_COVERAGE_PATH_BYTES)
				throw new TypeError(`coverage paths must be at most ${MAX_COVERAGE_PATH_BYTES} bytes`);
			for (const path of entry.coveredPaths) {
				if (Buffer.byteLength(path, "utf8") > MAX_COVERAGE_PATH_BYTES) throw new TypeError(`coverage paths must be at most ${MAX_COVERAGE_PATH_BYTES} bytes`);
			}
		}
		const maxDepth = resolveBound(input.maxDepth, DEFAULT_IMPACT_DEPTH, MAX_IMPACT_DEPTH, "maxDepth");
		const maxNodes = resolveBound(input.maxNodes, DEFAULT_IMPACT_NODES, MAX_IMPACT_NODES, "maxNodes");
		const maxEdges = resolveBound(input.maxEdges, DEFAULT_IMPACT_EDGES, MAX_IMPACT_EDGES, "maxEdges");
		const maxBytes = resolveBound(input.maxBytes, DEFAULT_IMPACT_BYTES, MAX_IMPACT_BYTES, "maxBytes");
		const deadlineMs = resolveBound(input.deadlineMs, DEFAULT_IMPACT_DEADLINE_MS, MAX_IMPACT_DEADLINE_MS, "deadlineMs");
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const rootPath = workspace.resolvePath(".");
		const deadlineAt = Date.now() + deadlineMs;
		const deadlineReached = () => Date.now() >= deadlineAt;
		let sourceCompleteness: ImpactAnalysisResult["sourceCompleteness"] = "complete";
		let files: readonly GitDiffFile[];
		if (input.source.kind === "git") {
			const diff = await deps.createGitPort(rootPath).diff(input.source.ref, Math.min(maxBytes, MAX_IMPACT_BYTES));
			files = diff.files;
			sourceCompleteness = diff.truncated ? "truncated" : "complete";
		} else {
			files = transactionFiles(await deps.mutationHistory.listTransaction(input.workspaceId, input.source.transactionId));
		}
		const beforePaths = files
			.filter((file) => file.status === "deleted" || file.status === "renamed")
			.map((file) => workspace.resolvePath(file.previousPath ?? file.path));
		const beforeNodes = beforePaths.length > 0 ? await deps.graph(input.workspaceId).nodesForFiles(beforePaths, maxNodes) : [];
		let cache = await deps.cacheStatus(registry, {
			workspaceId: input.workspaceId,
			maxFiles: input.maxFiles,
			maxSymbolsPerFile: input.maxSymbolsPerFile,
		});
		const needsPopulation = cache.status === "not-cached" || (cache.status === "cached" && files.length > 0);
		if (needsPopulation && input.autoPopulate) {
			await deps.populateSymbolGraph(registry, {
				workspaceId: input.workspaceId,
				maxFiles: input.maxFiles,
				maxSymbolsPerFile: input.maxSymbolsPerFile,
			});
			cache = await deps.cacheStatus(registry, {
				workspaceId: input.workspaceId,
				maxFiles: input.maxFiles,
				maxSymbolsPerFile: input.maxSymbolsPerFile,
			});
		}
		if (needsPopulation && !input.autoPopulate) throw new ImpactAnalysisRequiresFreshGraph(cache.status === "cached" ? "changed-source" : cache.status);
		if (cache.status !== "cached") throw new ImpactAnalysisRequiresFreshGraph(cache.status);
		const core = await changedSymbolImpact(deps.graph(input.workspaceId), files, {
			rootPath,
			maxDepth,
			maxNodes,
			maxEdges,
			deadlineMs: Math.max(1, deadlineAt - Date.now()),
		});
		const beforeChanged: ChangedSymbolEvidence[] = beforeNodes.flatMap((symbol) => {
			const file = files.find(
				(candidate) =>
					(candidate.status === "deleted" || candidate.status === "renamed") &&
					workspace.resolvePath(candidate.previousPath ?? candidate.path) === symbol.location.path,
			);
			return file ? [{ symbol, side: "before" as const, status: file.status }] : [];
		});
		const renamedAfter: ChangedSymbolEvidence[] = beforeChanged.flatMap(({ symbol, status }) => {
			const file = files.find(
				(candidate) =>
					candidate.status === "renamed" &&
					candidate.hunks.length === 0 &&
					workspace.resolvePath(candidate.previousPath ?? candidate.path) === symbol.location.path,
			);
			if (!file) return [];
			const location = { ...symbol.location, path: workspace.resolvePath(file.path) };
			return [{ symbol: { ...symbol, id: deriveSymbolNodeId(location), location }, side: "after" as const, status }];
		});
		const changedSymbols = [
			...beforeChanged,
			...core.changedSymbols.filter(({ symbol, side }) => side !== "before" || !beforeChanged.some((entry) => entry.symbol.id === symbol.id)),
			...renamedAfter.filter(({ symbol }) => !core.changedSymbols.some((entry) => entry.side === "after" && entry.symbol.id === symbol.id)),
		];
		const hierarchyImpacted: ImpactedSymbolEvidence[] = [];
		const hierarchySeen = new Set([...changedSymbols.map(({ symbol }) => symbol.id), ...core.impactedSymbols.map(({ symbol }) => symbol.id)]);
		for (const { symbol } of changedSymbols) {
			if (deadlineReached() || core.impactedSymbols.length + hierarchyImpacted.length >= maxNodes) break;
			for (const relation of ["supertype", "subtype"] as const) {
				if (deadlineReached() || core.impactedSymbols.length + hierarchyImpacted.length >= maxNodes) break;
				try {
					const result = await deps[relation === "supertype" ? "supertypes" : "subtypes"](registry, {
						workspaceId: input.workspaceId,
						...symbol.location,
						maxResults: Math.max(1, maxNodes - core.impactedSymbols.length - hierarchyImpacted.length),
						maxBytes: Math.max(1, Math.floor(maxBytes / 4)),
						deadlineMs: Math.max(1, deadlineAt - Date.now()),
					});
					for (const item of result.items) {
						const id = deriveSymbolNodeId(item.location);
						if (hierarchySeen.has(id)) continue;
						hierarchySeen.add(id);
						hierarchyImpacted.push({
							symbol: { id, name: item.name, kind: item.kind, location: item.location },
							depth: 1,
							evidence: { kind: "type-hierarchy", depth: 1, relation },
						});
					}
				} catch {
					// Capability-unavailable leaves semantic graph evidence intact and explicit elsewhere.
				}
			}
		}
		const impactedSymbols = [...core.impactedSymbols, ...hierarchyImpacted].sort(
			(left, right) =>
				left.depth - right.depth ||
				left.symbol.location.path.localeCompare(right.symbol.location.path) ||
				left.symbol.location.line - right.symbol.location.line ||
				left.symbol.location.character - right.symbol.location.character,
		);
		const allNodes = await deps.graph(input.workspaceId).allNodes(maxNodes);
		const changedPaths = files.flatMap((file) => [workspace.resolvePath(file.path), ...(file.previousPath ? [workspace.resolvePath(file.previousPath)] : [])]);
		const relatedTests = [
			...core.relatedTests,
			...(await heuristicTests(workspace, allNodes, changedPaths, core.relatedTests, input.coverage, deadlineReached)),
		];
		const boundaries = new Map<string, { path: string; marker: string; changedPaths: string[] }>();
		for (const path of changedPaths) {
			if (deadlineReached()) break;
			const found = await packageBoundary(workspace, rootPath, path);
			if (!found) continue;
			const entry = boundaries.get(found.path) ?? { ...found, changedPaths: [] };
			entry.changedPaths.push(path);
			boundaries.set(found.path, entry);
		}
		const diagnostics = [];
		for (const path of [...new Set(files.filter((file) => file.status !== "deleted").map((file) => workspace.resolvePath(file.path)))].sort()) {
			if (deadlineReached()) break;
			try {
				await using lease = await requireCodeIntelligence(deps.warmIndexes, { workspaceId: input.workspaceId, path });
				diagnostics.push({ path, diagnostics: await diagnosticsQuery(lease.value.index, path), unavailable: false });
			} catch {
				diagnostics.push({ path, diagnostics: [], unavailable: true });
			}
		}
		return boundResult(
			{
				...core,
				changedSymbols,
				impactedSymbols,
				truncated: core.truncated || sourceCompleteness === "truncated",
				deadlineReached: core.deadlineReached || deadlineReached(),
				source: input.source.kind === "git" ? { kind: "git", ref: input.source.ref ?? "HEAD" } : input.source,
				sourceCompleteness,
				graph: {
					completeness: "complete",
					...(cache.generation.provenance ? { provenance: cache.generation.provenance } : {}),
				},
				identityCompleteness:
					(beforePaths.length === 0 || beforePaths.every((path) => beforeNodes.some((node) => node.location.path === path))) &&
					files
						.filter((file) => file.status === "renamed")
						.every((file) => changedSymbols.some(({ side, symbol }) => side === "after" && symbol.location.path === workspace.resolvePath(file.path)))
						? "complete"
						: "partial",
				relatedTests,
				packageBoundaries: [...boundaries.values()].sort((left, right) => left.path.localeCompare(right.path)),
				diagnostics,
			},
			maxBytes,
		);
	};
}
