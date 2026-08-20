import { homedir } from "node:os";
import type { Logger } from "@danypops/vehicle-server/logging";
import type { BoundedJobExecutor } from "../concurrency/bounded-job-executor.ts";
import type { SerialExecutionQueue } from "../concurrency/serial-execution-queue.ts";
import type { GitPort } from "../git/port.ts";
import type { RepoFetcherPort } from "../repo-fetcher/port.ts";
import type { PopulateSymbolGraphResult } from "../symbol-graph/populate-symbol-graph.ts";
import type { WorkspaceId } from "./errors.ts";
import type { GraphRefreshCoordinator } from "./graph-refresh-coordinator.ts";
import type { MutationHistoryCoordinator } from "./mutation-history-handlers.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import { createCacheFreshnessHelpers } from "./symbol-graph/cache-freshness.ts";
import { createCacheQueryHandlers } from "./symbol-graph/cache-query-handlers.ts";
import { createGraphQueryHandlers } from "./symbol-graph/graph-query-handlers.ts";
import { createPopulationHandlers } from "./symbol-graph/population.ts";
import { PopulationProgressTracker } from "./symbol-graph/population-progress-tracker.ts";
import { createRefreshScheduler } from "./symbol-graph/refresh-scheduler.ts";
import { createRenameHandlers } from "./symbol-graph/rename-handlers.ts";
import type { WarmIndexRegistry } from "./warm-index-registry.ts";
import type { MutableRegistry } from "./workspace-registry.ts";

export interface SymbolGraphHandlerDeps {
	readonly registry: MutableRegistry;
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
	readonly graphRefresh: GraphRefreshCoordinator<WorkspaceId, string>;
	readonly repoFetcher: RepoFetcherPort | undefined;
	readonly createGitPort: (rootPath: string) => GitPort;
	readonly jobs: BoundedJobExecutor<PopulateSymbolGraphResult>;
	readonly logger: Logger;
	readonly renameMutationBarrier: SerialExecutionQueue;
	readonly publish: (topic: string, payload: unknown) => void;
	readonly mutationHistory: MutationHistoryCoordinator;
	/** Late-bound: WorkspaceWatchHandlers and this factory are mutually dependent (this needs
	 * ensureOsWatcher, WorkspaceWatchHandlers needs scheduleGraphRefresh below) -- the caller
	 * passes an initially-no-op indirection and rebinds it once both objects exist. */
	readonly ensureOsWatcher: (workspaceId: WorkspaceId, rootPath: string) => void;
	/** Injectable for tests -- classifyAutoPopulationRoot's own home-directory heuristic must never depend on the real host machine's actual home directory. Defaults to the real one via node:os. */
	readonly homeDir?: string;
	/** Injectable for tests -- the settle delay between populateSymbolGraphHandler's own retry-on-race attempts. Defaults to a real setTimeout-based wait. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Injectable for tests -- the clock populateSymbolGraphHandler's own retry budget is measured against. Defaults to Date.now. */
	readonly now?: () => number;
}

export interface SymbolGraphHandlers {
	"workspace.populateSymbolGraph": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	) => Promise<OperationOutputs["workspace.populateSymbolGraph"]>;
	"workspace.cacheStatus": (registry: MutableRegistry, input: OperationInputs["workspace.cacheStatus"]) => Promise<OperationOutputs["workspace.cacheStatus"]>;
	"workspace.cacheWalkedFiles": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.cacheWalkedFiles"],
	) => Promise<OperationOutputs["workspace.cacheWalkedFiles"]>;
	"workspace.cacheFailures": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.cacheFailures"],
	) => Promise<OperationOutputs["workspace.cacheFailures"]>;
	"workspace.activeCachingJobs": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.activeCachingJobs"],
	) => Promise<OperationOutputs["workspace.activeCachingJobs"]>;
	"workspace.referenceBasedRename": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.referenceBasedRename"],
	) => Promise<OperationOutputs["workspace.referenceBasedRename"]>;
	"workspace.prepareRename": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.prepareRename"],
	) => Promise<OperationOutputs["workspace.prepareRename"]>;
	"workspace.rename": (registry: MutableRegistry, input: OperationInputs["workspace.rename"]) => Promise<OperationOutputs["workspace.rename"]>;
	"workspace.reachableFrom": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.reachableFrom"],
	) => Promise<OperationOutputs["workspace.reachableFrom"]>;
	"workspace.symbolEdgesFrom": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesFrom"],
	) => Promise<OperationOutputs["workspace.symbolEdgesFrom"]>;
	"workspace.symbolEdgesTo": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesTo"],
	) => Promise<OperationOutputs["workspace.symbolEdgesTo"]>;
	"job.submit": (registry: MutableRegistry, request: OperationInputs["job.submit"]) => Promise<OperationOutputs["job.submit"]>;
	"job.status": (registry: MutableRegistry, input: OperationInputs["job.status"]) => Promise<OperationOutputs["job.status"]>;
	"job.watch": (registry: MutableRegistry, input: OperationInputs["job.watch"]) => Promise<OperationOutputs["job.watch"]>;
}

export interface SymbolGraphHandlerFactory {
	readonly handlers: SymbolGraphHandlers;
	/**
	 * Submits a fresh background population for `workspaceId` using its last generation's own
	 * bounds, deduplicated against any already-in-flight population the same way job.submit's
	 * own dedup works. Exposed standalone (not just reachable through `handlers`) because
	 * WorkspaceWatchHandlers calls it directly on every relevant file change, not through dispatch.
	 */
	scheduleGraphRefresh(workspaceId: WorkspaceId): Promise<void>;
}

/**
 * The genuinely entangled cluster the SOLID mitigation originally deferred: symbol-graph
 * population/cache-status, rename/referenceBasedRename (both need a fully-cached graph),
 * reachable-from/symbol-edges (pure graph reads), and the background-job admin trio (the only
 * job type is workspace.populateSymbolGraph). What made this risky before -- symbolIndexes/
 * ensureWarmIndex touched from 10+ call sites -- now lives in WarmIndexRegistry/
 * GraphRefreshCoordinator, passed in here as already-built collaborators rather than raw
 * closure state.
 *
 * This factory is purely a composition point: each real concern (cache-freshness, population,
 * cache-query, rename, refresh-scheduler, graph-query) is its own small factory module under
 * ./symbol-graph/, wired together here in dependency order (cache-freshness has no deps on the
 * others; population and cache-query both depend on cache-freshness; rename depends on
 * cache-query's cacheStatus and population's own handler; refresh-scheduler depends on
 * population's handler; graph-query is fully independent).
 */
export function createSymbolGraphHandlers(deps: SymbolGraphHandlerDeps): SymbolGraphHandlerFactory {
	const { registry, warmIndexes, graphRefresh, repoFetcher, createGitPort, jobs, logger, renameMutationBarrier, publish, ensureOsWatcher, mutationHistory } =
		deps;
	const homeDir = deps.homeDir ?? homedir();
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = deps.now ?? Date.now;

	const cacheFreshness = createCacheFreshnessHelpers({ repoFetcher, createGitPort, warmIndexes });
	const progressTracker = new PopulationProgressTracker();

	const population = createPopulationHandlers({
		registry,
		warmIndexes,
		graphRefresh,
		createGitPort,
		repoFetcher,
		logger,
		cacheFreshness,
		ensureOsWatcher,
		homeDir,
		sleep,
		now,
		progressTracker,
	});

	const cacheQuery = createCacheQueryHandlers({ registry, warmIndexes, graphRefresh, jobs, cacheFreshness, progressTracker });

	const rename = createRenameHandlers({
		registry,
		warmIndexes,
		renameMutationBarrier,
		mutationHistory,
		cacheStatus: cacheQuery.handlers["workspace.cacheStatus"],
		populateSymbolGraph: population["workspace.populateSymbolGraph"],
	});

	const refreshScheduler = createRefreshScheduler({
		registry,
		graphRefresh,
		jobs,
		logger,
		publish,
		populateSymbolGraph: population["workspace.populateSymbolGraph"],
	});

	const graphQuery = createGraphQueryHandlers({ ensureSymbolGraph: (workspaceId: WorkspaceId) => graphRefresh.graph(workspaceId) });

	return {
		handlers: {
			...population,
			...cacheQuery.handlers,
			...rename,
			...refreshScheduler.handlers,
			...graphQuery,
		},
		scheduleGraphRefresh: refreshScheduler.scheduleGraphRefresh,
	};
}
