import type { Logger } from "@danypops/vehicle-server/logging";
import { DebouncedScheduler } from "../concurrency/debounced-scheduler.ts";
import type { SymbolGraphPort } from "../symbol-graph/port.ts";

interface RefreshScheduler {
	schedule(key: string, callback: () => void): void;
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
	private readonly activeJobs = new Map<WorkspaceKey, JobKey>();
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
		return this.activeJobs.get(workspaceId);
	}

	setActiveJob(workspaceId: WorkspaceKey, jobId: JobKey): void {
		this.activeJobs.set(workspaceId, jobId);
	}

	clearActiveJob(workspaceId: WorkspaceKey, expectedJobId?: JobKey): void {
		if (expectedJobId !== undefined && this.activeJobs.get(workspaceId) !== expectedJobId) return;
		this.activeJobs.delete(workspaceId);
	}

	markWatched(workspaceId: WorkspaceKey): void {
		this.watchedWorkspaces.add(workspaceId);
	}

	isWatched(workspaceId: WorkspaceKey): boolean {
		return this.watchedWorkspaces.has(workspaceId);
	}

	schedule(workspaceId: WorkspaceKey, callback: () => void): void {
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
}
