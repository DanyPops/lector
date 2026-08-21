import { DebouncedScheduler } from "@danypops/vehicle-core";
import type { Logger } from "@danypops/vehicle-server/logging";
import type { SymbolGraphPort } from "../symbol-graph/port.ts";

/** Raised by releaseWorkspaceIfIdle when a populateSymbolGraph job for this workspace is still running -- closing the graph handle out from under it would corrupt bookkeeping the job still expects to find. */
export class GraphRefreshJobActive extends Error {
	constructor(readonly workspaceId: string) {
		super(`cannot release workspace "${workspaceId}": a populateSymbolGraph job for it is still running`);
		this.name = "GraphRefreshJobActive";
	}
}

interface RefreshScheduler {
	schedule(key: string, callback: () => unknown): void;
	cancel(key: string): void;
	clear(): void;
}

export interface GraphRefreshCoordinatorOptions<WorkspaceKey extends string> {
	readonly createGraph: (workspaceId: WorkspaceKey) => SymbolGraphPort;
	readonly debounceMs: number;
	readonly logger?: Logger;
	readonly scheduler?: RefreshScheduler;
}

/** Owns symbol-graph instances and every piece of graph-refresh lifecycle state. */
export class GraphRefreshCoordinator<WorkspaceKey extends string, JobKey extends string> {
	private readonly graphs = new Map<WorkspaceKey, SymbolGraphPort>();
	private readonly activeJobs = new Map<WorkspaceKey, { jobId: JobKey; ownerIds: Set<string> }>();
	private readonly watchedWorkspaces = new Set<WorkspaceKey>();
	private readonly scheduler: RefreshScheduler;

	constructor(private readonly options: GraphRefreshCoordinatorOptions<WorkspaceKey>) {
		this.scheduler = options.scheduler ?? new DebouncedScheduler(options.debounceMs, { logger: options.logger });
	}

	graph(workspaceId: WorkspaceKey): SymbolGraphPort {
		let graph = this.graphs.get(workspaceId);
		if (!graph) {
			graph = this.options.createGraph(workspaceId);
			this.graphs.set(workspaceId, graph);
		}
		return graph;
	}

	activeJob(workspaceId: WorkspaceKey): JobKey | undefined {
		return this.activeJobs.get(workspaceId)?.jobId;
	}

	/** Every [workspaceId, jobId] pair currently tracked as active. ownerId scopes presentation
	 * without changing global administrative inspection when omitted. */
	activeJobEntries(ownerId?: string): [WorkspaceKey, JobKey][] {
		const entries: [WorkspaceKey, JobKey][] = [];
		for (const [workspaceId, active] of this.activeJobs) {
			if (ownerId === undefined || active.ownerIds.has(ownerId)) entries.push([workspaceId, active.jobId]);
		}
		return entries;
	}

	setActiveJob(workspaceId: WorkspaceKey, jobId: JobKey, ownerId?: string): void {
		this.activeJobs.set(workspaceId, { jobId, ownerIds: new Set(ownerId ? [ownerId] : []) });
	}

	/** A second caller can share one deduplicated population job without stealing its first
	 * caller's ownership; both sessions then see the work they requested. */
	addActiveJobOwner(workspaceId: WorkspaceKey, expectedJobId: JobKey, ownerId: string): void {
		const active = this.activeJobs.get(workspaceId);
		if (active?.jobId === expectedJobId) active.ownerIds.add(ownerId);
	}

	clearActiveJob(workspaceId: WorkspaceKey, expectedJobId?: JobKey): void {
		if (expectedJobId !== undefined && this.activeJobs.get(workspaceId)?.jobId !== expectedJobId) return;
		this.activeJobs.delete(workspaceId);
	}

	markWatched(workspaceId: WorkspaceKey): void {
		this.watchedWorkspaces.add(workspaceId);
	}

	isWatched(workspaceId: WorkspaceKey): boolean {
		return this.watchedWorkspaces.has(workspaceId);
	}

	schedule(workspaceId: WorkspaceKey, callback: () => unknown): void {
		this.scheduler.schedule(workspaceId, callback);
	}

	async close(): Promise<void> {
		this.scheduler.clear();
		this.activeJobs.clear();
		this.watchedWorkspaces.clear();
		const graphs = Array.from(this.graphs.values());
		this.graphs.clear();
		await Promise.all(graphs.map((graph) => graph.close()));
	}

	/**
	 * Closes and forgets this one workspace's graph handle -- durable graph data on disk (a
	 * SQLite-backed graph) is untouched, only the in-memory handle is released, the same
	 * distinction every other Lector store's close() makes. Throws GraphRefreshJobActive (closes
	 * nothing) while a populateSymbolGraph job for this workspace is still running: closing the
	 * handle out from under an in-flight write would corrupt bookkeeping the job still expects to
	 * find. Also drops this workspace's own watched/debounce state so a later workspace.watch on
	 * the same id starts clean. Returns whether a graph handle actually existed to close -- a
	 * workspace whose graph was never populated legitimately closes nothing.
	 */
	async releaseWorkspaceIfIdle(workspaceId: WorkspaceKey): Promise<boolean> {
		if (this.activeJobs.has(workspaceId)) throw new GraphRefreshJobActive(workspaceId);
		// A debounced refresh scheduled just before release, but not yet fired, is not an "active
		// job" (setActiveJob only runs once the callback actually starts) -- without this it could
		// fire after release and repopulate a graph handle nothing is meant to be using anymore.
		this.scheduler.cancel(workspaceId);
		this.watchedWorkspaces.delete(workspaceId);
		const graph = this.graphs.get(workspaceId);
		if (!graph) return false;
		this.graphs.delete(workspaceId);
		await graph.close();
		return true;
	}
}
