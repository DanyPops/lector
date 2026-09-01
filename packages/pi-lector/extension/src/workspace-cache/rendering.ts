import type { CacheResultCounts, JobSnapshot, OperationOutputs, PopulateSymbolGraphResult, WorkspaceCacheStatus } from "@danypops/lector";
import type { LectorTheme } from "../lector-tui-theme.ts";
import { presentationTitle } from "../presentation/tool-presentation.ts";

type WorkspaceCacheAction = "status" | "populate" | "wait" | "job_status" | "release";

export function formatWorkspaceCacheCall(
	action: WorkspaceCacheAction,
	args: { directory?: unknown; maxFiles?: unknown; maxSymbolsPerFile?: unknown; jobId?: unknown },
	theme: LectorTheme,
): string {
	const label = theme.fg("toolTitle", theme.bold(presentationTitle("workspace_cache", action)));
	if (action === "job_status" || action === "wait") {
		const jobId = typeof args.jobId === "string" ? args.jobId : "";
		return `${label} ${theme.fg("accent", jobId)}`;
	}
	const directory = typeof args.directory === "string" ? args.directory : "";
	const maxFiles = typeof args.maxFiles === "number" ? String(args.maxFiles) : "default";
	const maxSymbolsPerFile = typeof args.maxSymbolsPerFile === "number" ? String(args.maxSymbolsPerFile) : "default";
	const bounds =
		action === "populate" && (typeof args.maxFiles === "number" || typeof args.maxSymbolsPerFile === "number")
			? theme.fg("dim", ` (maxFiles=${maxFiles}, maxSymbolsPerFile=${maxSymbolsPerFile})`)
			: "";
	return `${label} ${theme.fg("accent", directory)}${bounds}`;
}

function formatResultCounts(result: CacheResultCounts): string {
	const failed = result.filesFailed > 0 ? `, ${result.filesFailed} failed` : "";
	const reuse = result.filesReused === undefined ? "" : `, ${result.filesReused} reused, ${result.filesReprocessed ?? 0} reprocessed`;
	const retries = result.staleRetries ? `, ${result.staleRetries} stale ${result.staleRetries === 1 ? "retry" : "retries"}` : "";
	const coverage = result.sourceCoverage;
	const scopes = coverage?.scopes
		.slice(0, 3)
		.map((entry) => `${entry.scope}:${entry.files}`)
		.join(", ");
	const omitted = coverage ? coverage.scopeOmittedCount + Math.max(0, coverage.scopes.length - 3) : 0;
	const scopeSummary = scopes ? `; coverage ${scopes}${omitted > 0 ? ` (+${omitted} scopes)` : ""}${coverage?.truncated ? " [bounded]" : ""}` : "";
	return `${result.filesProcessed}/${result.filesAttempted} files${failed}${reuse}${retries}, ${result.symbolsProcessed} symbols, ${result.nodesAdded} nodes, ${result.edgesAdded} edges${scopeSummary}`;
}

export function formatWorkspaceReleaseModelContent(outcome: OperationOutputs["workspace.release"]): string {
	return [
		`released workspace ${outcome.workspaceId}`,
		`closed indexes: ${outcome.closedIndexes}`,
		`closed graph: ${outcome.closedGraph}`,
		`closed watch: ${outcome.closedWatch}`,
	].join("\n");
}

export function formatWorkspaceReleaseResult(outcome: OperationOutputs["workspace.release"] | undefined, theme: LectorTheme): string {
	if (!outcome) return theme.fg("dim", "No result.");
	return theme.fg(
		"success",
		`released ${outcome.workspaceId} -- ${outcome.closedIndexes} index(es), graph ${outcome.closedGraph ? "closed" : "idle"}, watch ${outcome.closedWatch ? "closed" : "idle"}`,
	);
}

export function formatWorkspaceCacheStatusResult(status: WorkspaceCacheStatus | undefined, theme: LectorTheme): string {
	if (!status) return theme.fg("dim", "No result.");
	if (status.status === "not-cached") return theme.fg("warning", `not cached (${status.reason})`);
	if (status.status === "caching") return theme.fg("accent", `caching (job ${status.jobId})`);
	if (status.status === "waiting-for-resources") return theme.fg("accent", `waiting for resources (job ${status.jobId})`);
	if (status.status === "partial") return theme.fg("warning", `partial -- ${formatResultCounts(status.generation.result)}`);
	return theme.fg("success", `cached -- ${formatResultCounts(status.generation.result)}`);
}

export function formatJobSnapshotResult(job: JobSnapshot<PopulateSymbolGraphResult> | undefined, theme: LectorTheme): string {
	if (!job) return theme.fg("dim", "No result.");
	if (job.status === "queued") return theme.fg("dim", `queued (job ${job.id})`);
	if (job.status === "running") return theme.fg("accent", `running (job ${job.id})`);
	if (job.status === "failed") return theme.fg("error", `failed (job ${job.id}): ${job.error.code}: ${job.error.message}`);
	return theme.fg("success", `succeeded (job ${job.id}) -- ${formatResultCounts(job.result)}`);
}
