import type { Diagnostic } from "../code-intelligence/diagnostic.ts";
import { type DiagnosticDelta, diagnosticDelta } from "../code-intelligence/diagnostic-delta.ts";
import type { IntelligenceProvenance } from "../code-intelligence/intelligence-provenance.ts";
import type { CodeIntelligencePort } from "../code-intelligence/port.ts";
import type { SymbolGraphPort, SymbolNode } from "../symbol-graph/port.ts";
import type { SymbolNodeId } from "../symbol-graph/symbol-node-id.ts";
import { requireCodeIntelligence } from "./code-intelligence-handlers.ts";
import type { WorkspaceId } from "./errors.ts";
import type { WarmIndexRegistry } from "./warm-index-registry.ts";

const MAX_RETAINED_VALIDATIONS = 128;
const MAX_AFFECTED_FILES = 500;
const MAX_DIAGNOSTICS_PER_FILE = 1_000;

export interface DiagnosticSnapshotFile {
	readonly path: string;
	readonly diagnostics: readonly Diagnostic[];
	readonly provenance?: IntelligenceProvenance;
	readonly unavailable: boolean;
}

export interface DiagnosticSnapshot {
	readonly files: readonly DiagnosticSnapshotFile[];
	readonly completeness: "complete" | "partial";
	readonly deadlineReached: boolean;
}

export interface DiagnosticValidationRecord {
	readonly transactionId: string;
	readonly before: DiagnosticSnapshot;
	readonly after: DiagnosticSnapshot;
}

export interface GitDiagnosticValidationResult extends DiagnosticDelta {
	readonly source: { readonly kind: "git"; readonly ref: string };
	readonly affectedPaths: readonly string[];
	readonly completeness: "complete" | "partial";
	readonly provenance: readonly IntelligenceProvenance[];
}

export interface DiagnosticValidationResult extends DiagnosticDelta {
	readonly source: { readonly kind: "transaction"; readonly transactionId: string };
	readonly transactionId: string;
	readonly affectedPaths: readonly string[];
	readonly completeness: "complete" | "partial";
	readonly provenance: readonly IntelligenceProvenance[];
	readonly revert: { readonly operation: "workspace.revertMutationTransaction"; readonly transactionId: string };
}

function compareNodes(left: SymbolNode, right: SymbolNode): number {
	return (
		left.location.path.localeCompare(right.location.path) || left.location.line - right.location.line || left.location.character - right.location.character
	);
}

export class DiagnosticValidationCoordinator {
	private readonly records = new Map<string, DiagnosticValidationRecord>();

	constructor(
		private readonly warmIndexes: WarmIndexRegistry<WorkspaceId>,
		private readonly graph: (workspaceId: WorkspaceId) => SymbolGraphPort,
	) {}

	async affectedPaths(workspaceId: WorkspaceId, changedPaths: readonly string[], maxDepth: number, maxNodes: number, maxEdges: number): Promise<string[]> {
		const graph = this.graph(workspaceId);
		const [changedNodes, nodes, edges] = await Promise.all([graph.nodesForFiles(changedPaths, maxNodes), graph.allNodes(maxNodes), graph.allEdges(maxEdges)]);
		const nodesById = new Map(nodes.map((node) => [node.id, node]));
		const incoming = new Map<SymbolNodeId, SymbolNodeId[]>();
		for (const edge of edges) {
			const values = incoming.get(edge.to) ?? [];
			values.push(edge.from);
			incoming.set(edge.to, values);
		}
		const seen = new Set(changedNodes.map((node) => node.id));
		let frontier = [...seen];
		const impacted: SymbolNode[] = [];
		for (let depth = 0; depth < maxDepth && frontier.length > 0 && impacted.length < maxNodes; depth += 1) {
			const next: SymbolNodeId[] = [];
			for (const target of frontier) {
				for (const id of incoming.get(target) ?? []) {
					if (seen.has(id)) continue;
					seen.add(id);
					const node = nodesById.get(id);
					if (!node) continue;
					impacted.push(node);
					next.push(id);
				}
			}
			frontier = next;
		}
		return [
			...new Set([
				...changedPaths,
				...[...changedNodes].sort(compareNodes).map((node) => node.location.path),
				...impacted.sort(compareNodes).map((node) => node.location.path),
			]),
		]
			.sort()
			.slice(0, MAX_AFFECTED_FILES);
	}

	async capture(workspaceId: WorkspaceId, paths: readonly string[], deadlineMs: number): Promise<DiagnosticSnapshot> {
		const deadlineAt = Date.now() + deadlineMs;
		const boundedPaths = [...new Set(paths)].sort().slice(0, MAX_AFFECTED_FILES);
		// Refresh every affected document before querying the first diagnostic. Cross-file servers can
		// otherwise report a transient dependent error while another changed declaration is still stale.
		const indexesByPath = new Map<string, CodeIntelligencePort>();
		for (const path of boundedPaths) {
			if (Date.now() >= deadlineAt) break;
			try {
				await using lease = await requireCodeIntelligence(this.warmIndexes, { workspaceId, path });
				indexesByPath.set(path, lease.value.index);
				await lease.value.index.documentSymbols(path);
			} catch {
				// The diagnostic phase records the path's unavailable state explicitly.
			}
		}
		const workspaceDiagnostics = new Map<string, Diagnostic[]>();
		const workspaceIndexes = new Set<CodeIntelligencePort>();
		for (const index of new Set(indexesByPath.values())) {
			if (!index.workspaceDiagnostics || Date.now() >= deadlineAt) continue;
			try {
				for (const diagnostic of await index.workspaceDiagnostics(MAX_AFFECTED_FILES, MAX_DIAGNOSTICS_PER_FILE, Math.max(1, deadlineAt - Date.now()))) {
					const entries = workspaceDiagnostics.get(diagnostic.range.path) ?? [];
					entries.push(diagnostic);
					workspaceDiagnostics.set(diagnostic.range.path, entries);
				}
				workspaceIndexes.add(index);
			} catch {
				// Fall back to bounded document diagnostics for every path served by this index.
			}
		}
		const files: DiagnosticSnapshotFile[] = [];
		for (const path of boundedPaths) {
			if (Date.now() >= deadlineAt) break;
			const preparedIndex = indexesByPath.get(path);
			if (preparedIndex && workspaceIndexes.has(preparedIndex)) {
				files.push({
					path,
					diagnostics: (workspaceDiagnostics.get(path) ?? []).slice(0, MAX_DIAGNOSTICS_PER_FILE),
					provenance: preparedIndex.provenance,
					unavailable: false,
				});
				continue;
			}
			try {
				await using lease = await requireCodeIntelligence(this.warmIndexes, { workspaceId, path });
				const diagnostics = (await lease.value.index.diagnostics(path, { timeoutMs: Math.max(1, deadlineAt - Date.now()) })).slice(0, MAX_DIAGNOSTICS_PER_FILE);
				files.push({ path, diagnostics, provenance: lease.value.index.provenance, unavailable: false });
			} catch {
				files.push({ path, diagnostics: [], unavailable: true });
			}
		}
		const deadlineReached = Date.now() >= deadlineAt;
		return {
			files,
			completeness:
				deadlineReached || files.some((file) => file.unavailable) || files.length < Math.min(new Set(paths).size, MAX_AFFECTED_FILES) ? "partial" : "complete",
			deadlineReached,
		};
	}

	record(transactionId: string, before: DiagnosticSnapshot, after: DiagnosticSnapshot): void {
		this.records.delete(transactionId);
		this.records.set(transactionId, { transactionId, before, after });
		while (this.records.size > MAX_RETAINED_VALIDATIONS) {
			const oldest = this.records.keys().next().value;
			if (typeof oldest !== "string") break;
			this.records.delete(oldest);
		}
	}

	result(transactionId: string): DiagnosticValidationResult | undefined {
		const record = this.records.get(transactionId);
		if (!record) return undefined;
		const before = record.before.files.flatMap((file) => file.diagnostics);
		const after = record.after.files.flatMap((file) => file.diagnostics);
		const provenance = [...record.before.files, ...record.after.files]
			.flatMap((file) => (file.provenance ? [file.provenance] : []))
			.filter((candidate, index, values) => values.findIndex((value) => JSON.stringify(value) === JSON.stringify(candidate)) === index);
		return {
			source: { kind: "transaction", transactionId },
			transactionId,
			...diagnosticDelta(before, after),
			affectedPaths: [...new Set([...record.before.files.map((file) => file.path), ...record.after.files.map((file) => file.path)])].sort(),
			completeness: record.before.completeness === "complete" && record.after.completeness === "complete" ? "complete" : "partial",
			provenance,
			revert: { operation: "workspace.revertMutationTransaction", transactionId },
		};
	}
}
