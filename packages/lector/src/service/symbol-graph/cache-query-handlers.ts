import { boundList } from "../../bounds/bound-list.ts";
import { LANGUAGE_SERVER_DESCRIPTORS } from "../../code-intelligence/language-server-descriptor.ts";
import { discoverWorkspaceDescriptors } from "../../code-intelligence/lsp/discover-seed-file.ts";
import type { BoundedJobExecutor } from "../../concurrency/bounded-job-executor.ts";
import type { PopulateSymbolGraphResult } from "../../symbol-graph/populate-symbol-graph.ts";
import { summarizeCacheGeneration } from "../../symbol-graph/summarize-cache-generation.ts";
import type { SymbolGraphGeneration } from "../../symbol-graph/symbol-graph-generation.ts";
import { deriveSourceManifest } from "../../workspace/source-manifest.ts";
import { MAX_SOURCE_MANIFEST_BYTES } from "../bounds.ts";
import { NoCompletedGeneration, SymbolQueryUnavailable, UnknownWorkspace, type WorkspaceId } from "../errors.ts";
import type { GraphRefreshCoordinator } from "../graph-refresh-coordinator.ts";
import type { OperationInputs, OperationOutputs } from "../operations.ts";
import type { WarmIndexRegistry } from "../warm-index-registry.ts";
import type { MutableRegistry } from "../workspace-registry.ts";
import type { CacheFreshnessHelpers } from "./cache-freshness.ts";

export interface CacheQueryHandlerDeps {
	readonly registry: MutableRegistry;
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
	readonly graphRefresh: GraphRefreshCoordinator<WorkspaceId, string>;
	readonly jobs: BoundedJobExecutor<PopulateSymbolGraphResult>;
	readonly cacheFreshness: Pick<CacheFreshnessHelpers, "refreshRemoteWorkspaceIfMoved" | "isCacheFreshViaGit">;
}

export interface CacheQueryHandlers {
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
}

export interface ActiveCachingJobSummary {
	workspaceId: WorkspaceId;
	status: "queued" | "running" | "waiting-for-resources";
}

export interface CacheQueryHandlerFactory {
	readonly handlers: CacheQueryHandlers;
	/** Exposed standalone (not just reachable through `handlers`) because rename needs to check cache freshness before trusting the graph's own reference set is complete. */
	requireCompletedGeneration(workspaceId: WorkspaceId): Promise<SymbolGraphGeneration>;
}

/** workspace.cacheStatus/cacheWalkedFiles/cacheFailures -- read-only queries against the current symbol-graph generation, sharing cacheFreshness's fast paths with population but never writing anything themselves. */
export function createCacheQueryHandlers(deps: CacheQueryHandlerDeps): CacheQueryHandlerFactory {
	const { registry, warmIndexes, graphRefresh, jobs, cacheFreshness } = deps;
	const ensureSymbolGraph = (workspaceId: WorkspaceId) => graphRefresh.graph(workspaceId);

	async function cacheStatusHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.cacheStatus"],
	): Promise<OperationOutputs["workspace.cacheStatus"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		const activeJobId = graphRefresh.activeJob(input.workspaceId);
		if (activeJobId) {
			const snapshot = jobs.status(activeJobId);
			if (snapshot.status === "running" && warmIndexes.waitingForAdmission(input.workspaceId)) {
				return { status: "waiting-for-resources", jobId: activeJobId };
			}
			if (snapshot.status === "queued" || snapshot.status === "running") return { status: "caching", jobId: activeJobId };
			graphRefresh.clearActiveJob(input.workspaceId);
		}
		const graph = ensureSymbolGraph(input.workspaceId);
		const generation = await graph.getGeneration();
		if (!generation) return { status: "not-cached", reason: "no-completed-generation" };
		if (generation.maxFiles !== input.maxFiles || generation.maxSymbolsPerFile !== input.maxSymbolsPerFile) {
			return { status: "not-cached", reason: "bounds-changed" };
		}
		// A remote-tracked workspace whose origin has moved is refetched in place right here, so
		// the full-rehash fallback below (the only check remote workspaces ever reach -- they never
		// carry a gitHeadSha, .git is stripped from a fetched clone) naturally sees the new content
		// and reports source-changed on its own; no separate status reason needed.
		await cacheFreshness.refreshRemoteWorkspaceIfMoved(input.workspaceId, entry, generation);
		// Fast path: skip the full source rehash below entirely when git alone already proves
		// nothing changed (same clean tree, same HEAD). Inconclusive (no recorded sha, dirty tree,
		// moved HEAD, any git error) always falls through to the authoritative full check --
		// this path can only ever short-circuit to the SAME answer the full check would give,
		// never a different one.
		if (generation.gitHeadSha !== undefined && (await cacheFreshness.isCacheFreshViaGit(entry.rootPath, generation.gitHeadSha))) {
			const summary = summarizeCacheGeneration(generation);
			return generation.result.completeness === "partial" ? { status: "partial", generation: summary } : { status: "cached", generation: summary };
		}
		const discovered = discoverWorkspaceDescriptors(entry.rootPath, LANGUAGE_SERVER_DESCRIPTORS);
		if (discovered.length === 0) return { status: "not-cached", reason: "source-changed" };
		const extensions = warmIndexes.sourceExtensions(discovered.map(({ descriptor }) => descriptor));
		let currentFingerprint: string;
		try {
			currentFingerprint = (await deriveSourceManifest(entry.rootPath, extensions, input.maxFiles, MAX_SOURCE_MANIFEST_BYTES)).fingerprint;
		} catch {
			return { status: "not-cached", reason: "source-changed" };
		}
		if (currentFingerprint !== generation.sourceFingerprint) return { status: "not-cached", reason: "source-changed" };
		const summary = summarizeCacheGeneration(generation);
		return generation.result.completeness === "partial" ? { status: "partial", generation: summary } : { status: "cached", generation: summary };
	}

	async function requireCompletedGeneration(workspaceId: WorkspaceId): Promise<SymbolGraphGeneration> {
		if (!registry.get(workspaceId)) throw new UnknownWorkspace(workspaceId);
		const generation = await ensureSymbolGraph(workspaceId).getGeneration();
		if (!generation) throw new NoCompletedGeneration(workspaceId);
		return generation;
	}

	async function cacheWalkedFilesHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.cacheWalkedFiles"],
	): Promise<OperationOutputs["workspace.cacheWalkedFiles"]> {
		const generation = await requireCompletedGeneration(input.workspaceId);
		const { page, totalCount, truncated } = boundList(generation.walkedFiles ?? [], input.offset, input.maxResults, input.maxBytes, (path) =>
			Buffer.byteLength(path, "utf8"),
		);
		return { files: page, totalCount, truncated };
	}

	async function cacheFailuresHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.cacheFailures"],
	): Promise<OperationOutputs["workspace.cacheFailures"]> {
		const generation = await requireCompletedGeneration(input.workspaceId);
		const { page, totalCount, truncated } = boundList(generation.result.failures, input.offset, input.maxResults, input.maxBytes, (failure) =>
			Buffer.byteLength(failure.message, "utf8"),
		);
		return { failures: page, totalCount, truncated: truncated || generation.result.failuresTruncated };
	}

	/** Enumerates every workspace with a currently active job -- mirrors cacheStatusHandler's own
	 * inline eviction (a job that already settled without a per-workspace cacheStatus call to
	 * notice is cleared here too, not left dangling). */
	async function activeCachingJobsHandler(): Promise<OperationOutputs["workspace.activeCachingJobs"]> {
		const active: ActiveCachingJobSummary[] = [];
		for (const [workspaceId, jobId] of graphRefresh.activeJobEntries()) {
			const snapshot = jobs.status(jobId);
			if (snapshot.status === "queued" || snapshot.status === "running") {
				const waiting = snapshot.status === "running" && warmIndexes.waitingForAdmission(workspaceId);
				active.push({ workspaceId, status: waiting ? "waiting-for-resources" : snapshot.status });
			} else {
				graphRefresh.clearActiveJob(workspaceId, jobId);
			}
		}
		return { jobs: active };
	}

	return {
		handlers: {
			"workspace.cacheStatus": cacheStatusHandler,
			"workspace.cacheWalkedFiles": cacheWalkedFilesHandler,
			"workspace.cacheFailures": cacheFailuresHandler,
			"workspace.activeCachingJobs": activeCachingJobsHandler,
		},
		requireCompletedGeneration,
	};
}
