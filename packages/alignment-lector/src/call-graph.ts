import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
	type ContributionCommand,
	type ContributionOutcome,
	type ContributionReadBounds,
	type ContributionResourceReference,
	ContributionResourceReferenceSchema,
} from "@alignment/surface-protocol";
// Deep import, not the "@danypops/lector" barrel -- see index.ts's own doc comment on why.
import { remoteErrorIs } from "@danypops/lector/client";
import type { LectorOperations } from "./lector-operations.js";
import type { SemanticProvenance, SemanticStatus } from "./semantic-navigation.js";

const MAX_CACHED_GRAPHS = 64;
const MAX_GRAPH_BYTES = 4 * 1024 * 1024;
const MAX_GRAPH_NODES = 1_000;
const MAX_GRAPH_EDGES = 2_000;
const MAX_GRAPH_DEPTH = 8;
const MAX_DEADLINE_MS = 30_000;

export const CALL_GRAPH_COMMANDS = [
	{ id: "lector.call-graph.prepare", title: "Prepare Call Hierarchy" },
	{ id: "lector.call-graph.incoming", title: "Show Callers" },
	{ id: "lector.call-graph.outgoing", title: "Show Callees" },
	{ id: "lector.call-graph.reachable", title: "Show Reachable Calls" },
] as const;

export type CallGraphStatus = SemanticStatus | "partial";
export type CallGraphDirection = "prepare" | "incoming" | "outgoing" | "reachable";

export interface CallGraphLocation {
	readonly path: string;
	readonly line: number;
	readonly character: number;
	readonly positionEncoding: "utf-16";
	readonly resource: ContributionResourceReference;
}

export interface CallGraphNodeProjection {
	readonly id: string;
	readonly name: string;
	readonly symbolKind: string;
	readonly location: CallGraphLocation;
	readonly range?: Readonly<Record<string, unknown>>;
	readonly open: {
		readonly commandId: "lector.file.open";
		readonly input: { readonly workspaceId: string; readonly path: string };
		readonly line: number;
		readonly character: number;
	};
}

export interface CallGraphEdgeProjection {
	readonly from: string;
	readonly to: string;
	readonly kind: "calls";
	readonly ranges?: readonly Readonly<Record<string, unknown>>[];
}

export interface CallGraphProjection {
	readonly kind: "call-graph";
	readonly direction: CallGraphDirection;
	readonly status: CallGraphStatus;
	readonly provenance: {
		readonly source: "live-language-server" | "live-code-intelligence" | "persisted-symbol-graph";
		readonly intelligence?: SemanticProvenance;
		readonly cacheStatus?: "cached" | "partial" | "caching" | "not-cached";
	};
	readonly nodes: readonly CallGraphNodeProjection[];
	readonly edges: readonly CallGraphEdgeProjection[];
	readonly truncated: boolean;
	readonly truncatedBy: readonly ("nodes" | "edges" | "depth" | "bytes" | "external")[];
	readonly staleReason?: string;
	readonly bounds: { readonly maxNodes: number; readonly maxEdges: number; readonly maxDepth: number; readonly maxBytes: number };
}

interface CachedGraph {
	readonly reference: ContributionResourceReference;
	readonly value: CallGraphProjection;
	readonly bytes: number;
	readonly entries: number;
}

interface GraphBounds {
	readonly maxNodes: number;
	readonly maxEdges: number;
	readonly maxBytes: number;
	readonly deadlineMs: number;
	readonly maxDepth: number;
}

interface ProjectedHierarchyEntry {
	readonly node: CallGraphNodeProjection;
	readonly range?: Readonly<Record<string, unknown>>;
}

function failure(code: string, message: string): ContributionOutcome<never> {
	return { ok: false, code, message };
}

function record(value: unknown): Record<string, unknown> | undefined {
	// This assertion follows the runtime object/null check and assigns no field meaning.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function boundedInteger(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum;
}

function semanticProvenance(value: unknown): SemanticProvenance | undefined {
	const parsed = record(value);
	if (
		!parsed ||
		(parsed.fidelity !== "semantic" && parsed.fidelity !== "structural") ||
		!nonEmptyString(parsed.backend) ||
		!nonEmptyString(parsed.languageId) ||
		(parsed.authority !== "language-server" && parsed.authority !== "parser" && parsed.authority !== "compiler") ||
		(parsed.freshness !== "live-process" && parsed.freshness !== "content-hash" && parsed.freshness !== "filesystem-snapshot") ||
		!Array.isArray(parsed.limitations) ||
		!parsed.limitations.every((entry) => typeof entry === "string")
	)
		return undefined;
	return {
		fidelity: parsed.fidelity,
		backend: parsed.backend,
		languageId: parsed.languageId,
		authority: parsed.authority,
		freshness: parsed.freshness,
		limitations: parsed.limitations,
	};
}

function graphStatus(source: SemanticProvenance): SemanticStatus {
	if (source.fidelity === "structural") return "degraded";
	return source.freshness === "live-process" ? "ready" : "stale";
}

function isUnsupported(error: unknown): boolean {
	return ["UnsupportedLanguage", "NoSeedFileFound", "CodeIntelligenceUnavailable"].some((name) => remoteErrorIs(error, name));
}

function remainingDeadline(deadlineAt: number): number {
	const remaining = deadlineAt - Date.now();
	if (remaining <= 0) throw new DOMException("Call graph deadline exceeded", "TimeoutError");
	return remaining;
}

function signalFrom(input: Record<string, unknown>): AbortSignal | undefined {
	return input.signal instanceof AbortSignal ? input.signal : undefined;
}

async function callBounded(operations: LectorOperations, operation: string, input: unknown, deadlineMs: number, signal?: AbortSignal): Promise<unknown> {
	if (signal?.aborted) throw new DOMException("Call graph request canceled", "AbortError");
	return await new Promise((resolvePromise, rejectPromise) => {
		let settled = false;
		const finish = (callback: (value: unknown) => void, value: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", canceled);
			callback(value);
		};
		const canceled = () => finish(rejectPromise, new DOMException("Call graph request canceled", "AbortError"));
		const timer = setTimeout(() => finish(rejectPromise, new DOMException("Call graph deadline exceeded", "TimeoutError")), deadlineMs);
		signal?.addEventListener("abort", canceled, { once: true });
		void operations.call(operation, input).then(
			(value) => finish(resolvePromise, value),
			(error: unknown) => finish(rejectPromise, error),
		);
	});
}

function graphReference(id: string, title: string): ContributionResourceReference {
	return { uri: `lector://call-graph/${id}`, kind: "call-graph", title, readOnly: true };
}

function graphResourceId(resource: ContributionResourceReference): string | undefined {
	const parsed = ContributionResourceReferenceSchema.safeParse(resource);
	if (!parsed.success || parsed.data.readOnly !== true || parsed.data.kind !== "call-graph") return undefined;
	try {
		const uri = new URL(parsed.data.uri);
		const id = uri.pathname.slice(1);
		return uri.protocol === "lector:" && uri.hostname === "call-graph" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function textReference(workspaceId: string, path: string): ContributionResourceReference {
	const title = path.split(/[\\/]/).at(-1) ?? path;
	return { uri: `lector://text/${encodeURIComponent(workspaceId)}?path=${encodeURIComponent(path)}`, kind: "text", title, readOnly: true };
}

export interface CallGraphContribution {
	readonly commands: readonly ContributionCommand[];
	registerWorkspace(workspaceId: string, rootPath: string): void;
	read(resource: ContributionResourceReference, bounds: ContributionReadBounds): ContributionOutcome<unknown> | undefined;
	clear(): void;
}

export function createCallGraphContribution(operations: LectorOperations): CallGraphContribution {
	const resources = new Map<string, CachedGraph>();
	const workspaceRoots = new Map<string, string>();
	let nextId = 1;

	function projectPath(root: string, path: unknown): string | undefined {
		if (!nonEmptyString(path)) return undefined;
		const projected = relative(root, isAbsolute(path) ? path : resolve(root, path));
		return projected === ".." || projected.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(projected) ? undefined : projected;
	}

	function workspacePath(workspaceId: string, path: unknown): ContributionOutcome<{ absolute: string; project: string; root: string }> {
		const root = workspaceRoots.get(workspaceId);
		if (!root) return failure("workspace-not-open", "Workspace must be opened through this contribution before call-graph navigation");
		if (!nonEmptyString(path) || isAbsolute(path)) return failure("invalid-input", "Call-graph paths must be non-empty and workspace-relative");
		const absolute = resolve(root, path);
		const project = projectPath(root, absolute);
		return project ? { ok: true, value: { absolute, project, root } } : failure("invalid-input", "Call-graph path escapes the workspace");
	}

	function projectRange(root: string, value: unknown): Readonly<Record<string, unknown>> | undefined {
		const range = record(value);
		const start = record(range?.start);
		const end = record(range?.end);
		const path = projectPath(root, range?.path);
		if (
			!path ||
			!start ||
			!end ||
			!boundedInteger(start.line, Number.MAX_SAFE_INTEGER) ||
			!boundedInteger(start.character, Number.MAX_SAFE_INTEGER) ||
			!boundedInteger(end.line, Number.MAX_SAFE_INTEGER) ||
			!boundedInteger(end.character, Number.MAX_SAFE_INTEGER)
		)
			return undefined;
		return { path, start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } };
	}

	function stableNodeId(workspaceId: string, path: string, line: number, character: number): string {
		const digest = createHash("sha256").update(`${workspaceId}\0${path}\0${line}\0${character}`).digest("hex").slice(0, 24);
		return `symbol:${digest}`;
	}

	function node(
		workspaceId: string,
		root: string,
		value: { name: string; kind: string; path: unknown; line: unknown; character: unknown; range?: unknown },
	): CallGraphNodeProjection | undefined {
		const path = projectPath(root, value.path);
		if (!path || !boundedInteger(value.line, Number.MAX_SAFE_INTEGER) || !boundedInteger(value.character, Number.MAX_SAFE_INTEGER)) return undefined;
		const location: CallGraphLocation = {
			path,
			line: value.line,
			character: value.character,
			positionEncoding: "utf-16",
			resource: textReference(workspaceId, path),
		};
		const range = value.range === undefined ? undefined : projectRange(root, value.range);
		if (value.range !== undefined && !range) return undefined;
		return {
			id: stableNodeId(workspaceId, path, value.line, value.character),
			name: value.name,
			symbolKind: value.kind,
			location,
			...(range ? { range } : {}),
			open: { commandId: "lector.file.open", input: { workspaceId, path }, line: value.line, character: value.character },
		};
	}

	function hierarchyEntry(workspaceId: string, root: string, value: unknown): ProjectedHierarchyEntry | undefined {
		const entry = record(value);
		const location = record(entry?.location);
		if (!entry || !location || !nonEmptyString(entry.name) || !nonEmptyString(entry.kind)) return undefined;
		const projected = node(workspaceId, root, {
			name: entry.name,
			kind: entry.kind,
			path: location.path,
			line: location.line,
			character: location.character,
			range: entry.range,
		});
		return projected ? { node: projected, range: projected.range } : undefined;
	}

	function persistedNode(workspaceId: string, root: string, value: unknown): CallGraphNodeProjection | undefined {
		const parsed = record(value);
		const location = record(parsed?.location);
		if (!parsed || !location || !nonEmptyString(parsed.name) || !nonEmptyString(parsed.kind)) return undefined;
		return node(workspaceId, root, {
			name: parsed.name,
			kind: parsed.kind,
			path: location.path,
			line: location.line,
			character: location.character,
		});
	}

	function parseBounds(input: Record<string, unknown>, reachable: boolean): ContributionOutcome<GraphBounds> {
		if (
			!boundedInteger(input.maxNodes, MAX_GRAPH_NODES) ||
			!boundedInteger(input.maxEdges, MAX_GRAPH_EDGES) ||
			!boundedInteger(input.maxBytes, MAX_GRAPH_BYTES) ||
			!boundedInteger(input.deadlineMs, MAX_DEADLINE_MS)
		)
			return failure("invalid-input", "Call graph requires bounded maxNodes/maxEdges/maxBytes/deadlineMs");
		let maxDepth = 1;
		if (reachable) {
			if (!boundedInteger(input.maxDepth, MAX_GRAPH_DEPTH)) return failure("invalid-input", `Reachable graph maxDepth must be 1-${MAX_GRAPH_DEPTH}`);
			maxDepth = input.maxDepth;
		}
		return {
			ok: true,
			value: {
				maxNodes: input.maxNodes,
				maxEdges: input.maxEdges,
				maxBytes: input.maxBytes,
				deadlineMs: input.deadlineMs,
				maxDepth,
			},
		};
	}

	function cache(title: string, value: CallGraphProjection, bounds: GraphBounds): ContributionOutcome<ContributionResourceReference> {
		const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
		const entries = value.nodes.length + value.edges.length;
		if (bytes > bounds.maxBytes || bytes > MAX_GRAPH_BYTES)
			return failure("resource-bound-exceeded", `Call graph is ${bytes} bytes; command cap is ${bounds.maxBytes}`);
		const id = String(nextId++);
		const reference = graphReference(id, title);
		resources.set(id, { reference, value, bytes, entries });
		while (resources.size > MAX_CACHED_GRAPHS) resources.delete(resources.keys().next().value ?? "");
		return { ok: true, value: reference };
	}

	async function liveGraph(
		direction: Exclude<CallGraphDirection, "reachable">,
		input: Record<string, unknown>,
	): Promise<ContributionOutcome<ContributionResourceReference>> {
		if (!nonEmptyString(input.workspaceId) || !boundedInteger(input.line, Number.MAX_SAFE_INTEGER) || !boundedInteger(input.character, Number.MAX_SAFE_INTEGER))
			return failure("invalid-input", "Live call graph requires workspaceId and a 1-indexed position");
		const resolved = workspacePath(input.workspaceId, input.path);
		if (!resolved.ok) return resolved;
		const bounded = parseBounds(input, false);
		if (!bounded.ok) return bounded;
		const signal = signalFrom(input);
		const deadlineAt = Date.now() + bounded.value.deadlineMs;
		const request = { workspaceId: input.workspaceId, path: resolved.value.absolute, line: input.line, character: input.character };
		const prepared = record(await callBounded(operations, "workspace.prepareCallHierarchy", request, remainingDeadline(deadlineAt), signal));
		const prepareSource = semanticProvenance(prepared?.provenance);
		if (!prepared || !prepareSource || !Array.isArray(prepared.items)) return failure("invalid-response", "Lector returned an invalid call-hierarchy root");
		const nodes = new Map<string, CallGraphNodeProjection>();
		const edges = new Map<string, CallGraphEdgeProjection>();
		const truncatedBy = new Set<"nodes" | "edges" | "depth" | "bytes" | "external">();
		const roots: CallGraphNodeProjection[] = [];
		for (const candidate of prepared.items) {
			const projected = hierarchyEntry(input.workspaceId, resolved.value.root, candidate);
			if (!projected) return failure("invalid-response", "Lector returned a call-hierarchy root outside the workspace");
			if (nodes.size >= bounded.value.maxNodes) {
				truncatedBy.add("nodes");
				continue;
			}
			nodes.set(projected.node.id, projected.node);
			roots.push(projected.node);
		}
		let source = prepareSource;
		if (direction !== "prepare" && roots.length > 0) {
			const operation = direction === "incoming" ? "workspace.incomingCalls" : "workspace.outgoingCalls";
			const output = record(await callBounded(operations, operation, request, remainingDeadline(deadlineAt), signal));
			source = semanticProvenance(output?.provenance) ?? source;
			if (!output || !Array.isArray(output.calls)) return failure("invalid-response", "Lector returned invalid call relationships");
			for (const candidate of output.calls) {
				const call = record(candidate);
				if (!call) return failure("invalid-response", "Lector returned a non-object call relationship");
				const projected = hierarchyEntry(input.workspaceId, resolved.value.root, direction === "incoming" ? call.from : call.to);
				if (!projected) {
					truncatedBy.add("external");
					continue;
				}
				if (!Array.isArray(call.fromRanges)) return failure("invalid-response", "Lector returned invalid call-site ranges");
				if (!nodes.has(projected.node.id) && nodes.size >= bounded.value.maxNodes) {
					truncatedBy.add("nodes");
					continue;
				}
				nodes.set(projected.node.id, projected.node);
				for (const rootNode of roots) {
					if (edges.size >= bounded.value.maxEdges) {
						truncatedBy.add("edges");
						break;
					}
					const from = direction === "incoming" ? projected.node.id : rootNode.id;
					const to = direction === "incoming" ? rootNode.id : projected.node.id;
					const ranges = call.fromRanges.map((range) => projectRange(resolved.value.root, range));
					if (ranges.some((range) => !range)) return failure("invalid-response", "Lector returned call-site ranges outside the workspace");
					const key = `${from}\0${to}`;
					edges.set(key, { from, to, kind: "calls", ranges: ranges.filter((range): range is Readonly<Record<string, unknown>> => range !== undefined) });
				}
			}
		}
		const provenanceSource = source.authority === "language-server" ? "live-language-server" : "live-code-intelligence";
		return cache(
			direction === "prepare" ? "Call hierarchy" : direction === "incoming" ? "Callers" : "Callees",
			{
				kind: "call-graph",
				direction,
				status: graphStatus(source),
				provenance: { source: provenanceSource, intelligence: source },
				nodes: [...nodes.values()],
				edges: [...edges.values()],
				truncated: truncatedBy.size > 0,
				truncatedBy: [...truncatedBy],
				bounds: bounded.value,
			},
			bounded.value,
		);
	}

	async function reachableGraph(input: Record<string, unknown>): Promise<ContributionOutcome<ContributionResourceReference>> {
		if (!nonEmptyString(input.workspaceId) || !boundedInteger(input.line, Number.MAX_SAFE_INTEGER) || !boundedInteger(input.character, Number.MAX_SAFE_INTEGER))
			return failure("invalid-input", "Reachable call graph requires workspaceId and a 1-indexed position");
		const resolved = workspacePath(input.workspaceId, input.path);
		if (!resolved.ok) return resolved;
		const bounded = parseBounds(input, true);
		if (!bounded.ok) return bounded;
		const cacheBounds = record(input.cacheBounds);
		if (!cacheBounds || !boundedInteger(cacheBounds.maxFiles, 10_000) || !boundedInteger(cacheBounds.maxSymbolsPerFile, 10_000))
			return failure("invalid-input", "Reachable call graph requires explicit cacheBounds");
		const signal = signalFrom(input);
		const deadlineAt = Date.now() + bounded.value.deadlineMs;
		const cacheState = record(
			await callBounded(
				operations,
				"workspace.cacheStatus",
				{ workspaceId: input.workspaceId, maxFiles: cacheBounds.maxFiles, maxSymbolsPerFile: cacheBounds.maxSymbolsPerFile },
				remainingDeadline(deadlineAt),
				signal,
			),
		);
		if (
			!cacheState ||
			(cacheState.status !== "cached" &&
				cacheState.status !== "partial" &&
				cacheState.status !== "caching" &&
				cacheState.status !== "waiting-for-resources" &&
				cacheState.status !== "not-cached")
		)
			return failure("invalid-response", "Lector returned an invalid symbol-graph cache status");
		// "waiting-for-resources" (queued behind foreground admission, not yet walking files) reads
		// the same as "caching" here -- both mean "not ready yet, still working towards a real
		// generation", the only distinction this projection's own cacheStatus field needs to make.
		const cacheStatus = cacheState.status === "waiting-for-resources" ? "caching" : cacheState.status;
		if (cacheStatus === "not-cached" || cacheStatus === "caching") {
			const staleReason =
				cacheStatus === "caching"
					? "symbol graph population is still running"
					: nonEmptyString(cacheState.reason)
						? cacheState.reason
						: "no-completed-generation";
			return cache(
				"Reachable calls",
				{
					kind: "call-graph",
					direction: "reachable",
					status: cacheStatus === "caching" ? "partial" : "stale",
					provenance: { source: "persisted-symbol-graph", cacheStatus },
					nodes: [],
					edges: [],
					truncated: false,
					truncatedBy: [],
					staleReason,
					bounds: bounded.value,
				},
				bounded.value,
			);
		}

		const generation = record(cacheState.generation);
		const intelligence = semanticProvenance(generation?.provenance);
		const root = node(input.workspaceId, resolved.value.root, {
			name: "Selected symbol",
			kind: "unknown",
			path: resolved.value.absolute,
			line: input.line,
			character: input.character,
		});
		if (!root) return failure("invalid-input", "Selected call-graph position is outside the workspace");
		const nodes = new Map<string, CallGraphNodeProjection>([[root.id, root]]);
		const edges = new Map<string, CallGraphEdgeProjection>();
		const queue: Array<{ node: CallGraphNodeProjection; absolutePath: string; depth: number }> = [
			{ node: root, absolutePath: resolved.value.absolute, depth: 0 },
		];
		const expanded = new Set<string>();
		const truncatedBy = new Set<"nodes" | "edges" | "depth" | "bytes" | "external">();
		while (queue.length > 0) {
			const current = queue.shift();
			if (!current || expanded.has(current.node.id)) continue;
			expanded.add(current.node.id);
			const output = record(
				await callBounded(
					operations,
					"workspace.symbolEdgesFrom",
					{
						workspaceId: input.workspaceId,
						path: current.absolutePath,
						line: current.node.location.line,
						character: current.node.location.character,
						kind: "calls",
					},
					remainingDeadline(deadlineAt),
					signal,
				),
			);
			if (!output || !Array.isArray(output.symbols)) return failure("invalid-response", "Lector returned invalid persisted graph nodes");
			if (current.depth >= bounded.value.maxDepth) {
				if (output.symbols.length > 0) truncatedBy.add("depth");
				continue;
			}
			for (const candidate of output.symbols) {
				const child = persistedNode(input.workspaceId, resolved.value.root, candidate);
				if (!child) return failure("invalid-response", "Lector returned a persisted graph node outside the workspace");
				const existing = nodes.get(child.id);
				if (!existing && nodes.size >= bounded.value.maxNodes) {
					truncatedBy.add("nodes");
					continue;
				}
				if (!existing || existing.name === "Selected symbol") nodes.set(child.id, child);
				if (edges.size >= bounded.value.maxEdges) {
					truncatedBy.add("edges");
					continue;
				}
				edges.set(`${current.node.id}\0${child.id}`, { from: current.node.id, to: child.id, kind: "calls" });
				if (!expanded.has(child.id)) queue.push({ node: child, absolutePath: resolve(resolved.value.root, child.location.path), depth: current.depth + 1 });
			}
		}
		return cache(
			"Reachable calls",
			{
				kind: "call-graph",
				direction: "reachable",
				status: cacheStatus === "partial" ? "partial" : intelligence ? graphStatus(intelligence) : "ready",
				provenance: { source: "persisted-symbol-graph", cacheStatus, ...(intelligence ? { intelligence } : {}) },
				nodes: [...nodes.values()],
				edges: [...edges.values()],
				truncated: truncatedBy.size > 0,
				truncatedBy: [...truncatedBy],
				bounds: bounded.value,
			},
			bounded.value,
		);
	}

	async function execute(direction: CallGraphDirection, input: unknown): Promise<ContributionOutcome<ContributionResourceReference>> {
		const parsed = record(input);
		if (!parsed) return failure("invalid-input", "Call-graph command input must be an object");
		try {
			return direction === "reachable" ? await reachableGraph(parsed) : await liveGraph(direction, parsed);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") return failure("canceled", "Call-graph request was canceled");
			if (error instanceof DOMException && error.name === "TimeoutError") return failure("deadline-exceeded", "Call-graph request exceeded its deadline");
			if (isUnsupported(error)) return failure("unsupported", error instanceof Error ? error.message : "Call graph is unsupported");
			return failure("lector-error", error instanceof Error ? error.message : "Lector call-graph operation failed");
		}
	}

	const directions: readonly CallGraphDirection[] = ["prepare", "incoming", "outgoing", "reachable"];
	const commands = CALL_GRAPH_COMMANDS.map(
		(description, index): ContributionCommand => ({ ...description, execute: async (input) => await execute(directions[index] ?? "prepare", input) }),
	);

	return {
		commands,
		registerWorkspace(workspaceId, rootPath) {
			workspaceRoots.set(workspaceId, rootPath);
		},
		read(resource, bounds) {
			const id = graphResourceId(resource);
			if (!id) return undefined;
			const cached = resources.get(id);
			if (!cached || cached.reference.uri !== resource.uri) return failure("resource-not-found", "Call graph is unavailable or expired");
			if (cached.entries > bounds.maxEntries || cached.bytes > bounds.maxBytes)
				return failure("resource-bound-exceeded", `Call graph has ${cached.entries} entries and ${cached.bytes} bytes`);
			return { ok: true, value: cached.value };
		},
		clear() {
			resources.clear();
			workspaceRoots.clear();
		},
	};
}
