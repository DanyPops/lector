import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import type { Logger } from "@danypops/vehicle-server/logging";
import type { GitPort } from "../../git/port.ts";
import type { RepoFetcherPort } from "../../repo-fetcher/port.ts";
import { computeUpdatedFileContentHashes } from "../../symbol-graph/compute-updated-file-content-hashes.ts";
import { findDependentFiles } from "../../symbol-graph/find-dependent-files.ts";
import { mergePopulationResult } from "../../symbol-graph/merge-population-result.ts";
import { populateSymbolGraph as populateSymbolGraphQuery } from "../../symbol-graph/populate-symbol-graph.ts";
import { purgeFilesNoLongerWalked } from "../../symbol-graph/purge-stale-graph-entries.ts";
import { diffFileHashes } from "../../symbol-graph/select-files-to-reprocess.ts";
import { classifyAutoPopulationRoot } from "../../workspace/classify-auto-population-root.ts";
import { deriveSourceManifest } from "../../workspace/source-manifest.ts";
import {
	MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP,
	MAX_POPULATE_RETRY_BUDGET_MS,
	MAX_SOURCE_MANIFEST_BYTES,
	POPULATE_RETRY_SETTLE_MS,
	POPULATION_CONCURRENCY,
	resolveRetryBudgetMs,
} from "../bounds.ts";
import { BroadNonProjectRoot, CodeIntelligenceUnavailable, SymbolQueryUnavailable, WorkspaceChangedDuringPopulation, type WorkspaceId } from "../errors.ts";
import type { GraphRefreshCoordinator } from "../graph-refresh-coordinator.ts";
import type { OperationInputs, OperationOutputs } from "../operations.ts";
import { supportsCodeIntelligence, type WarmIndexRegistry } from "../warm-index-registry.ts";
import type { MutableRegistry } from "../workspace-registry.ts";
import type { CacheFreshnessHelpers } from "./cache-freshness.ts";
import type { PopulationProgressTracker } from "./population-progress-tracker.ts";

export interface PopulationHandlerDeps {
	readonly registry: MutableRegistry;
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
	readonly graphRefresh: GraphRefreshCoordinator<WorkspaceId, string>;
	readonly createGitPort: (rootPath: string) => GitPort;
	readonly repoFetcher: RepoFetcherPort | undefined;
	readonly logger: Logger;
	readonly cacheFreshness: Pick<CacheFreshnessHelpers, "refreshRemoteWorkspaceIfMoved" | "captureGitHeadShaIfClean">;
	/** Late-bound: WorkspaceWatchHandlers and this factory are mutually dependent -- the caller passes an initially-no-op indirection and rebinds it once both objects exist. */
	readonly ensureOsWatcher: (workspaceId: WorkspaceId, rootPath: string) => void;
	/** Shared with cache-query-handlers.ts so workspace.cacheStatus/activeCachingJobs can report a real, live files-processed/files-total fraction while this handler's own populateSymbolGraphQuery call is still running. */
	readonly progressTracker: PopulationProgressTracker;
	/** Injectable for tests -- classifyAutoPopulationRoot's own home-directory heuristic must never depend on the real host machine's actual home directory. Defaults to the real one via node:os. */
	readonly homeDir?: string;
	/** Injectable for tests -- the settle delay between populateSymbolGraphHandler's own retry-on-race attempts. Defaults to a real setTimeout-based wait. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Injectable for tests -- the clock populateSymbolGraphHandler's own retry budget is measured against. Defaults to Date.now. */
	readonly now?: () => number;
}

export interface PopulationHandlers {
	"workspace.populateSymbolGraph": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	) => Promise<OperationOutputs["workspace.populateSymbolGraph"]>;
}

/** populateSymbolGraph's own lifecycle: delta selection against the previous generation, remote-refetch-if-moved, purge, re-walk, and recording a fresh generation. */
export function createPopulationHandlers(deps: PopulationHandlerDeps): PopulationHandlers {
	const { registry, warmIndexes, graphRefresh, createGitPort, repoFetcher, logger, cacheFreshness, ensureOsWatcher, progressTracker } = deps;
	const homeDir = deps.homeDir ?? homedir();
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = deps.now ?? Date.now;
	const ensureSymbolGraph = (workspaceId: WorkspaceId) => graphRefresh.graph(workspaceId);

	/**
	 * Public entry point: validates the optional retry budget, then retries populateSymbolGraphOnce
	 * across a real WorkspaceChangedDuringPopulation race (a file changed mid-population, so no
	 * generation was recorded) until either an attempt succeeds or the budget is exhausted, at which
	 * point the same error propagates unchanged. Omitted/0 retryTimeBudgetMs (the default) makes this
	 * behave exactly like a single populateSymbolGraphOnce call -- today's fail-fast contract,
	 * unchanged for any caller that doesn't opt in.
	 *
	 * Safe to retry: populateSymbolGraphOnce's own writes (ensureNode/addEdge, and the purge step) are
	 * idempotent against the graph's current state, and a failed attempt never calls setGeneration, so
	 * previousGeneration for the next attempt is whatever the last genuinely completed generation was
	 * -- identical delta-selection behavior to a fresh, independent call.
	 */
	async function populateSymbolGraphHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	): Promise<OperationOutputs["workspace.populateSymbolGraph"]> {
		const retryBudgetMs = resolveRetryBudgetMs(input.retryTimeBudgetMs, MAX_POPULATE_RETRY_BUDGET_MS);
		const startedAt = now();
		const deadline = retryBudgetMs > 0 ? startedAt + retryBudgetMs : undefined;
		let attempt = 0;
		try {
			for (;;) {
				attempt++;
				try {
					return await populateSymbolGraphOnce(_registry, input);
				} catch (error) {
					if (!(error instanceof WorkspaceChangedDuringPopulation)) throw error;
					const elapsedMs = now() - startedAt;
					if (deadline === undefined || now() >= deadline) {
						// Distinguishes "the workspace kept changing on every attempt until the budget ran
						// out" from a single-attempt fail-fast call (retryTimeBudgetMs omitted/0) -- both
						// otherwise surface as the same WorkspaceChangedDuringPopulation error with no way
						// to tell how many attempts were actually made.
						logger.warn("symbol graph population: retry budget exhausted under continuous workspace churn", {
							module: "population",
							operation: "workspace.populateSymbolGraph",
							workspaceId: input.workspaceId,
							attempts: attempt,
							elapsedMs: Math.round(elapsedMs),
							retryBudgetMs,
						});
						throw error;
					}
					logger.debug("symbol graph population: source changed mid-scan, retrying", {
						module: "population",
						operation: "workspace.populateSymbolGraph",
						workspaceId: input.workspaceId,
						attempt,
						elapsedMs: Math.round(elapsedMs),
						retryBudgetMs,
					});
					await sleep(POPULATE_RETRY_SETTLE_MS);
				}
			}
		} finally {
			// Every attempt shares the same workspaceId key -- clearing once here (success or final
			// failure) rather than per-attempt avoids a misleading brief gap in reported progress
			// between a retried attempt's own last progress report and the next attempt's first one.
			progressTracker.clear(input.workspaceId);
		}
	}

	async function populateSymbolGraphOnce(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	): Promise<OperationOutputs["workspace.populateSymbolGraph"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry?.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		const rootPath = entry.rootPath;
		if (!input.allowBroadRoot) {
			const topLevelEntries = await readdir(rootPath).catch(() => [] as string[]);
			if (classifyAutoPopulationRoot({ rootPath, homeDir, topLevelEntries }) === "broad-non-project") {
				throw new BroadNonProjectRoot(rootPath);
			}
		}
		const graph = ensureSymbolGraph(input.workspaceId);
		// Purge before repopulating: a file walked last generation but absent from this one was
		// deleted (or moved out of scope), and its stale nodes/edges must not survive indefinitely.
		const previousGeneration = await graph.getGeneration();
		// A remote-tracked workspace whose origin has moved past the last recorded commit is
		// refetched in place, and any already-warm index evicted, BEFORE ensureWorkspaceIndex
		// below -- an already-warm LSP process built its own project state from the old
		// directory and does not survive having it swapped out from under it, and "before"
		// further down must see the freshly-fetched content, not what was on disk previously.
		await cacheFreshness.refreshRemoteWorkspaceIfMoved(input.workspaceId, entry, previousGeneration);
		// "background": populateSymbolGraph is self-scheduled, unlike an interactive query, and must
		// never be able to grow the warm-index pool past the slots reserved for foreground work --
		// it queues (bounded, cancellable) instead of competing for admission on equal footing.
		await using workspaceLease = await warmIndexes.leaseWorkspaceIndex(input.workspaceId, undefined, "background");
		const workspaceIndex = workspaceLease.value;
		if (!supportsCodeIntelligence(workspaceIndex.index)) throw new CodeIntelligenceUnavailable(input.workspaceId);
		const extensions = warmIndexes.sourceExtensions(workspaceIndex.descriptors);
		const before = await deriveSourceManifest(rootPath, extensions, input.maxFiles, MAX_SOURCE_MANIFEST_BYTES);

		// Delta selection: a file whose content hash matches the previous generation's needs no
		// LSP round trip at all. A changed or deleted file's own declarations may have shifted
		// position, so any OTHER file with a direct edge into them must be re-walked too, or its
		// own outgoing edge is silently lost when the changed file's stale nodes are purged (see
		// findDependentFiles). Computed BEFORE any purge, against the graph as it still stands.
		const currentFileSet = new Set(before.absoluteFiles);
		const deletedFiles = (previousGeneration?.walkedFiles ?? []).filter((path) => !currentFileSet.has(path));
		const { changed, unchanged } = diffFileHashes(before.absoluteFiles, before.fileHashes, previousGeneration?.fileContentHashes);

		let filesToReprocess: readonly string[] = before.absoluteFiles;
		let filesToSkip: readonly string[] = [];
		if (unchanged.length > 0) {
			if (changed.length === 0 && deletedFiles.length === 0) {
				filesToReprocess = [];
				filesToSkip = unchanged;
			} else {
				const invalidated = new Set([...changed, ...deletedFiles]);
				const [nodes, edges] = await Promise.all([
					graph.allNodes(MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP + 1),
					graph.allEdges(MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP + 1),
				]);
				const withinLookupBound = nodes.length <= MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP && edges.length <= MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP;
				if (withinLookupBound) {
					const dependents = findDependentFiles(nodes, edges, invalidated);
					const reprocessSet = new Set([...changed, ...dependents]);
					filesToReprocess = [...reprocessSet];
					filesToSkip = unchanged.filter((file) => !reprocessSet.has(file));
				}
			}
		}

		await purgeFilesNoLongerWalked(graph, previousGeneration?.walkedFiles, before.absoluteFiles);
		// Only genuinely-changed files' own nodes are purged -- their positions may have shifted.
		// A dependent file's own declarations haven't moved, so purging it would also cascade-delete
		// a THIRD file's still-valid edge into it for no reason; reprocessing alone (idempotent
		// addNode/addEdge) already refreshes its outgoing edges correctly.
		for (const file of changed) await graph.removeNodesForFile(file);

		const reprocessResult = await populateSymbolGraphQuery(
			workspaceIndex.index,
			graph,
			filesToReprocess,
			input.maxSymbolsPerFile,
			logger,
			POPULATION_CONCURRENCY,
			(progress) => progressTracker.set(input.workspaceId, progress),
		);
		const after = await deriveSourceManifest(rootPath, extensions, input.maxFiles, MAX_SOURCE_MANIFEST_BYTES);
		if (after.fingerprint !== before.fingerprint) throw new WorkspaceChangedDuringPopulation(input.workspaceId);

		const result = mergePopulationResult(reprocessResult, filesToSkip.length, before.absoluteFiles.length);
		const fileContentHashes = computeUpdatedFileContentHashes(
			previousGeneration?.fileContentHashes,
			filesToSkip,
			filesToReprocess,
			before.fileHashes,
			reprocessResult.failures,
			reprocessResult.failuresTruncated,
		);

		await graph.setGeneration({
			sourceFingerprint: after.fingerprint,
			maxFiles: input.maxFiles,
			maxSymbolsPerFile: input.maxSymbolsPerFile,
			completedAt: Date.now(),
			provenance: workspaceIndex.index.provenance,
			sources: workspaceIndex.sources,
			result,
			gitHeadSha: await cacheFreshness.captureGitHeadShaIfClean(rootPath),
			walkedFiles: before.absoluteFiles,
			fileContentHashes,
			remoteReference: entry.remoteReference,
			remoteCommit: entry.remoteReference ? await repoFetcher?.resolveRemoteCommit(entry.remoteReference) : undefined,
		});
		// A workspace that has been populated at least once stays graph-watched for the rest of
		// the daemon's uptime -- the whole point of "keeps the symbol graph warm on disk changes".
		// Gated on being a real git repository: a raw, non-git directory (workspaceForPath's own
		// intentional fs-root/scratch-file fallback, or any other broad/ambiguous root) must never
		// get an automatic, unbounded OS-level recursive watcher armed against it -- a real risk of
		// resource exhaustion/runaway watcher processes. populateSymbolGraph itself still
		// honors an explicit, one-off request against any workspace; only the *automatic* rearm on
		// every future file change requires git. A remote-origin workspace is always git-backed (it
		// was cloned by GitRepoFetcher) -- skipping the redundant real `git` subprocess check for it
		// avoids adding latency to the exact refetch-then-repopulate window where a freshly-swapped
		// checkout's warm LSP process is most timing-sensitive (a real regression this caused,
		// caught live: an added git subprocess call there destabilized a warm tsserver's project
		// state into "No Project" under load).
		if (entry.origin === "remote" || (await createGitPort(rootPath).isGitRepository())) {
			graphRefresh.markWatched(input.workspaceId);
			ensureOsWatcher(input.workspaceId, rootPath);
		}
		return result;
	}

	return { "workspace.populateSymbolGraph": populateSymbolGraphHandler };
}
