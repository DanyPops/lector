import type { PopulationProgress } from "../../symbol-graph/populate-symbol-graph.ts";
import type { WorkspaceId } from "../errors.ts";

/**
 * Pure, in-memory bookkeeping of the latest known progress for whichever workspace currently has
 * a populateSymbolGraph job running -- deliberately NOT owned by BoundedJobExecutor itself, which
 * stays a generic, work-agnostic job runner with no concept of "files processed". Shared between
 * population.ts (the only writer) and cache-query-handlers.ts (the only reader) as a small
 * injected collaborator, the same pattern cache-freshness.ts's own helpers already follow.
 *
 * Keyed by workspaceId, not jobId: every reader already has workspaceId in hand (from
 * GraphRefreshCoordinator's own activeJob bookkeeping) before it would ever need to look up
 * progress, and a workspace has at most one active population at a time, so no collision risk
 * from reusing the same key across a retry's several attempts.
 */
export class PopulationProgressTracker {
	private readonly progress = new Map<WorkspaceId, PopulationProgress>();

	set(workspaceId: WorkspaceId, progress: PopulationProgress): void {
		this.progress.set(workspaceId, progress);
	}

	get(workspaceId: WorkspaceId): PopulationProgress | undefined {
		return this.progress.get(workspaceId);
	}

	/** Called once a population finishes (success or failure) so a later query never returns a stale snapshot from a run that's already over. */
	clear(workspaceId: WorkspaceId): void {
		this.progress.delete(workspaceId);
	}
}
