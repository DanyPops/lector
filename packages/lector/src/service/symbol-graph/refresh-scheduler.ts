import type { Logger } from "@danypops/vehicle-server/logging";
import type { BoundedJobExecutor } from "../../concurrency/bounded-job-executor.ts";
import type { PopulateSymbolGraphResult } from "../../symbol-graph/populate-symbol-graph.ts";
import { MAX_INITIAL_JOB_WAIT_MS, MAX_POPULATE_RETRY_BUDGET_MS } from "../bounds.ts";
import { InvalidJobInput, JobWaitTooLong, jobTopicFor, jobWatchIdFor, UnknownWorkspace, UnsupportedJobOperation, type WorkspaceId } from "../errors.ts";
import type { GraphRefreshCoordinator } from "../graph-refresh-coordinator.ts";
import type { OperationInputs, OperationOutputs } from "../operations.ts";
import type { MutableRegistry } from "../workspace-registry.ts";

export interface RefreshSchedulerDeps {
	readonly registry: MutableRegistry;
	readonly graphRefresh: GraphRefreshCoordinator<WorkspaceId, string>;
	readonly jobs: BoundedJobExecutor<PopulateSymbolGraphResult>;
	readonly logger: Logger;
	readonly publish: (topic: string, payload: unknown) => void;
	readonly populateSymbolGraph: (
		registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	) => Promise<OperationOutputs["workspace.populateSymbolGraph"]>;
}

export interface RefreshSchedulerHandlers {
	"job.submit": (registry: MutableRegistry, request: OperationInputs["job.submit"]) => Promise<OperationOutputs["job.submit"]>;
	"job.status": (registry: MutableRegistry, input: OperationInputs["job.status"]) => Promise<OperationOutputs["job.status"]>;
	"job.watch": (registry: MutableRegistry, input: OperationInputs["job.watch"]) => Promise<OperationOutputs["job.watch"]>;
}

export interface RefreshSchedulerFactory {
	readonly handlers: RefreshSchedulerHandlers;
	/**
	 * Submits a fresh background population for `workspaceId` using its last generation's own
	 * bounds, deduplicated against any already-in-flight population the same way job.submit's
	 * own dedup works. Exposed standalone (not just reachable through `handlers`) because
	 * WorkspaceWatchHandlers calls it directly on every relevant file change, not through dispatch.
	 */
	scheduleGraphRefresh(workspaceId: WorkspaceId): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** job.submit/status/watch and the self-scheduling watch-triggered refresh loop -- the only job type is workspace.populateSymbolGraph, dispatched through the injected populateSymbolGraph handler rather than owning that logic itself. */
export function createRefreshScheduler(deps: RefreshSchedulerDeps): RefreshSchedulerFactory {
	const { registry, graphRefresh, jobs, logger, publish, populateSymbolGraph } = deps;

	async function scheduleGraphRefresh(workspaceId: WorkspaceId): Promise<void> {
		const workspace = registry.get(workspaceId);
		if (!workspace) return; // workspace no longer known -- nothing to refresh
		const existingJobId = graphRefresh.activeJob(workspaceId);
		if (existingJobId) {
			const existing = jobs.status(existingJobId);
			if (existing.status === "queued" || existing.status === "running") {
				graphRefresh.schedule(workspaceId, () => scheduleGraphRefresh(workspaceId));
				return;
			}
			graphRefresh.clearActiveJob(workspaceId);
		}
		const generation = await graphRefresh.graph(workspaceId).getGeneration();
		if (!generation) return; // never populated (or its cache was reset) -- nothing to keep warm
		// A completed generation already exists -- classifyAutoPopulationRoot already approved this
		// root (or it was explicitly allowed) the first time population ran; re-asking on every
		// subsequent watch-triggered refresh of an already-established project is pure overhead.
		const input = { workspaceId, maxFiles: generation.maxFiles, maxSymbolsPerFile: generation.maxSymbolsPerFile, allowBroadRoot: true };
		let submittedJobId = "";
		const submitted = jobs.submit({
			operation: "workspace.populateSymbolGraph",
			priority: workspace.origin,
			run: async () => {
				try {
					return await populateSymbolGraph(registry, input);
				} finally {
					graphRefresh.clearActiveJob(workspaceId, submittedJobId);
				}
			},
		});
		submittedJobId = submitted.id;
		graphRefresh.setActiveJob(workspaceId, submitted.id);
	}

	async function submitJobHandler(_registry: MutableRegistry, request: OperationInputs["job.submit"]): Promise<OperationOutputs["job.submit"]> {
		const rawRequest: unknown = request;
		if (!isRecord(rawRequest)) throw new InvalidJobInput("request must be an object");
		const operation = rawRequest.operation;
		if (operation !== "workspace.populateSymbolGraph") throw new UnsupportedJobOperation(String(operation));
		const rawInput = rawRequest.input;
		if (!isRecord(rawInput)) throw new InvalidJobInput("input must be an object");
		const { workspaceId, maxFiles, maxSymbolsPerFile } = rawInput;
		if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new InvalidJobInput("workspaceId must be a non-empty string");
		if (typeof maxFiles !== "number" || !Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new InvalidJobInput("maxFiles must be a positive safe integer");
		if (typeof maxSymbolsPerFile !== "number" || !Number.isSafeInteger(maxSymbolsPerFile) || maxSymbolsPerFile < 1) {
			throw new InvalidJobInput("maxSymbolsPerFile must be a positive safe integer");
		}
		const rawWaitMs = rawRequest.waitMs;
		const waitMs = rawWaitMs ?? 0;
		if (typeof waitMs !== "number" || !Number.isSafeInteger(waitMs) || waitMs < 0) throw new InvalidJobInput("waitMs must be a non-negative safe integer");
		if (waitMs > MAX_INITIAL_JOB_WAIT_MS) throw new JobWaitTooLong(waitMs, MAX_INITIAL_JOB_WAIT_MS);
		const rawOwnerId = rawRequest.ownerId;
		if (rawOwnerId !== undefined && (typeof rawOwnerId !== "string" || rawOwnerId.length === 0 || rawOwnerId.length > 200)) {
			throw new InvalidJobInput("ownerId must be a non-empty string no longer than 200 characters when given");
		}
		const ownerId = rawOwnerId;
		const rawAllowBroadRoot = rawInput.allowBroadRoot;
		if (rawAllowBroadRoot !== undefined && typeof rawAllowBroadRoot !== "boolean") throw new InvalidJobInput("allowBroadRoot must be a boolean when given");
		const rawRetryTimeBudgetMs = rawInput.retryTimeBudgetMs;
		const retryTimeBudgetMs = rawRetryTimeBudgetMs ?? 0;
		if (
			typeof retryTimeBudgetMs !== "number" ||
			!Number.isSafeInteger(retryTimeBudgetMs) ||
			retryTimeBudgetMs < 0 ||
			retryTimeBudgetMs > MAX_POPULATE_RETRY_BUDGET_MS
		) {
			throw new InvalidJobInput(`retryTimeBudgetMs must be a non-negative safe integer no greater than ${MAX_POPULATE_RETRY_BUDGET_MS}`);
		}
		const workspace = registry.get(workspaceId);
		if (!workspace) throw new UnknownWorkspace(workspaceId);
		const existingJobId = graphRefresh.activeJob(workspaceId);
		if (existingJobId) {
			const existing = jobs.status(existingJobId);
			if (existing.status === "queued" || existing.status === "running") {
				if (ownerId) graphRefresh.addActiveJobOwner(workspaceId, existing.id, ownerId);
				return { job: waitMs === 0 ? existing : await jobs.wait(existing.id, waitMs) };
			}
			graphRefresh.clearActiveJob(workspaceId);
		}
		const input = { workspaceId, maxFiles, maxSymbolsPerFile, allowBroadRoot: rawAllowBroadRoot, retryTimeBudgetMs };
		let submittedJobId = "";
		const submitted = jobs.submit({
			operation,
			priority: workspace.origin,
			run: async () => {
				try {
					return await populateSymbolGraph(registry, input);
				} finally {
					graphRefresh.clearActiveJob(workspaceId, submittedJobId);
				}
			},
		});
		submittedJobId = submitted.id;
		graphRefresh.setActiveJob(workspaceId, submitted.id, ownerId);
		jobs.onTerminal(submitted.id, (job) => {
			try {
				publish(jobTopicFor(job.id), { job });
			} catch {
				logger.warn("background job terminal event publish failed", { component: "background-jobs", jobId: job.id });
			}
		});
		return { job: waitMs === 0 ? submitted : await jobs.wait(submitted.id, waitMs) };
	}

	function validatedJobId(input: unknown): string {
		if (!isRecord(input) || typeof input.jobId !== "string" || input.jobId.length === 0) throw new InvalidJobInput("jobId must be a non-empty string");
		return input.jobId;
	}

	function jobStatusHandler(_registry: MutableRegistry, input: OperationInputs["job.status"]): Promise<OperationOutputs["job.status"]> {
		const jobId = validatedJobId(input);
		return Promise.resolve({ job: jobs.status(jobId) });
	}

	function jobWatchHandler(_registry: MutableRegistry, input: OperationInputs["job.watch"]): Promise<OperationOutputs["job.watch"]> {
		const jobId = validatedJobId(input);
		jobs.status(jobId);
		return Promise.resolve({ watchId: jobWatchIdFor(jobId), topic: jobTopicFor(jobId) });
	}

	return {
		handlers: {
			"job.submit": submitJobHandler,
			"job.status": jobStatusHandler,
			"job.watch": jobWatchHandler,
		},
		scheduleGraphRefresh,
	};
}
