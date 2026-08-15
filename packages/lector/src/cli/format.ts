import type { JobSnapshot } from "../concurrency/bounded-job-executor.ts";
import type { PackageSourceOperationResult } from "../package-source/package-source.ts";
import type { SymbolAnnotation } from "../symbol-annotation/symbol-annotation.ts";
import type { PopulateSymbolGraphResult } from "../symbol-graph/populate-symbol-graph.ts";
import type { CacheGenerationResultSummary } from "../symbol-graph/symbol-graph-generation.ts";
import type { SymbolSearchResult } from "../workspace/workspace-symbol.ts";

/** The CLI's plain-text presentation layer -- every non-JSON `console.log` formatter, with zero dependency on argv parsing or per-command dispatch logic. */

export function formatSymbolSources(result: SymbolSearchResult): readonly string[] {
	return (result.sources ?? []).map((source) => {
		const identity = `${source.provenance.languageId}: ${source.status} via ${source.provenance.backend}`;
		if (source.status === "failed") return source.error ? `${identity} [${source.error.code}] ${source.error.message}` : identity;
		return `${identity} (${source.symbolCount} symbol${source.symbolCount === 1 ? "" : "s"}${source.truncated ? ", truncated" : ""})`;
	});
}

export function formatIntelligenceSource(provenance: { fidelity: string; backend: string }): string {
	return `${provenance.fidelity} via ${provenance.backend}`;
}

export function formatCallHierarchyEntry(entry: { kind: string; name: string; location: { path: string; line: number; character: number } }): string {
	return `${entry.kind} ${entry.name} -- ${entry.location.path}:${entry.location.line}:${entry.location.character}`;
}

export function formatSymbolNode(node: { kind: string; name: string; location: { path: string; line: number; character: number } }): string {
	return `${node.kind} ${node.name} -- ${node.location.path}:${node.location.line}:${node.location.character}`;
}

export function formatPopulationResult(result: PopulateSymbolGraphResult): string {
	const counts = `${result.filesProcessed}/${result.filesAttempted} files, ${result.symbolsProcessed} symbols, ${result.nodesAdded} nodes, ${result.edgesAdded} edges`;
	if (result.completeness === "complete") return counts;
	const first = result.failures[0];
	const failure = first ? `; first failure: ${first.path} [${first.code} via ${first.provenance.backend}] ${first.message}` : "";
	return `partial -- ${counts}, ${result.filesFailed} failed files (${result.failureCount} failed operations)${failure}`;
}

export function formatCacheGenerationSummaryResult(result: CacheGenerationResultSummary): string {
	const counts = `${result.filesProcessed}/${result.filesAttempted} files, ${result.symbolsProcessed} symbols, ${result.nodesAdded} nodes, ${result.edgesAdded} edges`;
	if (result.completeness === "complete") return counts;
	const first = result.failureSummary[0];
	const failure = first ? `; first failure: ${first.path} [${first.code}] ${first.message}` : "";
	return `partial -- ${counts}, ${result.filesFailed} failed files (${result.failureCount} failed operations)${failure}`;
}

export function formatJobSnapshot(job: JobSnapshot<PopulateSymbolGraphResult>): string {
	if (job.status === "queued") return `${job.id}: queued (${job.operation}); wait with: lector job wait ${job.id}`;
	if (job.status === "running") return `${job.id}: still running (${job.operation}); wait with: lector job wait ${job.id}`;
	if (job.status === "failed") return `${job.id}: failed [${job.error.code}] -- ${job.error.message}`;
	return `${job.id}: succeeded -- ${formatPopulationResult(job.result)}`;
}

export function formatPackageSourceResult(result: PackageSourceOperationResult): string {
	const { outcome } = result;
	switch (outcome.status) {
		case "verified":
			return `${result.workspaceId ?? "unregistered"} ${outcome.coordinate.name}@${outcome.coordinate.resolvedVersion} -- ${outcome.workspace.cachePath}\n${outcome.repository.url ?? "local source"}@${outcome.repository.resolvedRef ?? "local"} ${outcome.repository.commit ?? outcome.verification.integrity}`;
		case "ambiguous":
			return `ambiguous [${outcome.code}] -- ${outcome.candidates.map((candidate) => `${candidate.version} (${candidate.source})`).join(", ")}${outcome.truncated ? ", …" : ""}`;
		case "unauthenticated":
			return `unauthenticated [${outcome.code}] -- configure ${outcome.requiredCredentialNames.join(", ")}`;
		case "oversized":
			return `oversized [${outcome.code}] -- ${outcome.resource} exceeded ${outcome.limit}`;
		case "mismatched":
			return `mismatched [${outcome.code}] -- expected ${outcome.expected}, got ${outcome.actual}`;
		case "unavailable":
			return `unavailable [${outcome.code}]`;
		default: {
			const exhaustive: never = outcome;
			throw new Error(`unhandled package source outcome status: ${JSON.stringify(exhaustive)}`);
		}
	}
}

export function formatPackageSourceListEntry(entry: {
	name: string;
	resolvedVersion: string;
	workspaceId: string;
	cachePath: string;
	cacheSizeBytes: number | null;
}): string {
	const bytes = entry.cacheSizeBytes === null ? "" : ` (${entry.cacheSizeBytes} bytes)`;
	return `${entry.name}@${entry.resolvedVersion} -- ${entry.workspaceId} -- ${entry.cachePath}${bytes}`;
}

export function formatAnnotation(annotation: SymbolAnnotation): string {
	const anchorLines = annotation.anchors.map((anchor) => `  - ${anchor.symbolNodeId}`).join("\n");
	return `[${annotation.status}] ${annotation.title} (${annotation.subtype}) [${annotation.id}]\n${annotation.body}\nAnchors:\n${anchorLines}`;
}
