import { VehicleRegistry } from "@danypops/vehicle-server";
import type { Logger } from "@danypops/vehicle-server/logging";
import { FallbackCodeIntelligenceIndex } from "./code-intelligence/fallback-code-intelligence-index.ts";
import { LANGUAGE_SERVER_DESCRIPTORS, type LanguageServerDescriptor } from "./code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "./code-intelligence/lsp/lsp-symbol-index.ts";
import { TreeSitterSymbolIndex } from "./code-intelligence/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { TypeScriptCompilerSymbolIndex } from "./code-intelligence/typescript-compiler-symbol-index.ts";
import type { WarmIndexResourcePolicy } from "./code-intelligence/warm-index-resource-policy.ts";
import { BoundedJobExecutor } from "./concurrency/bounded-job-executor.ts";
import { SerialExecutionQueue } from "./concurrency/serial-execution-queue.ts";
import { InMemoryContentCache } from "./content-cache/in-memory-content-cache.ts";
import type { ContentCachePort } from "./content-cache/port.ts";
import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeCandidate } from "./external-search/external-search-result.ts";
import { EXTERNAL_SEARCH_PERMISSIONS, registerExternalSearchOperations } from "./external-search/operation-registration.ts";
import { InMemoryExternalSearchCache } from "./external-search-cache/in-memory-external-search-cache.ts";
import type { ExternalSearchCachePort } from "./external-search-cache/port.ts";
import { NodeFsFileWatcher } from "./file-watcher/node-fs-file-watcher.ts";
import type { FileWatcherPort } from "./file-watcher/port.ts";
import { WatchLimitExceeded } from "./file-watcher/watch-registry.ts";
import { LocalGit } from "./git/local-git.ts";
import { GIT_READ_PERMISSIONS, registerGitOperations } from "./git/operation-registration.ts";
import type { GitPort } from "./git/port.ts";
import { GithubSearchClient } from "./github-search/github-search-client.ts";
import type { GithubSearchPort } from "./github-search/port.ts";
import { NpmLockfileVersionResolver } from "./installed-package-version-resolver/npm-lockfile-version-resolver.ts";
import type { LanguageServerProvisionerPort } from "./lsp-provisioning/port.ts";
import {
	MUTATION_HISTORY_READ_PERMISSIONS,
	MUTATION_HISTORY_WRITE_PERMISSIONS,
	registerMutationHistoryOperations,
} from "./mutation-history/operation-registration.ts";
import type { MutationHistoryPort } from "./mutation-history/port.ts";
import { NpmPackageSourceResolver } from "./npm-registry/npm-package-source-resolver.ts";
import { NpmRegistryClient } from "./npm-registry/npm-registry-client.ts";
import type { NpmRegistryPort } from "./npm-registry/port.ts";
import { dispatchThroughOperationRegistry } from "./operation-dispatch/dispatch-through-registry.ts";
import { InMemoryPackageSourceIndex } from "./package-source/in-memory-package-source-index.ts";
import type { PackageSourceIndexPort } from "./package-source/index-port.ts";
import type { PackageSourceResolverPort } from "./package-source/resolver-port.ts";
import { RelativeWorkspacePath } from "./path-safety/assert-absolute-path.ts";
import { REPO_LIST_CACHE_PERMISSIONS, REPO_WRITE_PERMISSIONS, registerRepoFetchOperations } from "./repo-fetcher/operation-registration.ts";
import type { RepoFetcherPort } from "./repo-fetcher/port.ts";
import { InMemorySearchCache } from "./search-cache/in-memory-search-cache.ts";
import type { SearchCachePort } from "./search-cache/port.ts";
import { AnnotationHandlers } from "./service/annotation-handlers.ts";
import { createCodeIntelligenceHandlers } from "./service/code-intelligence-handlers.ts";
import { createCrossWorkspaceHandlers } from "./service/cross-workspace-handlers.ts";
import { SymbolQueryUnavailable, UnknownWorkspace, UnsupportedLanguage, type WorkspaceId } from "./service/errors.ts";
import { createExternalSearchHandlers } from "./service/external-search-handlers.ts";
import { createGitHandlers } from "./service/git-handlers.ts";
import { GraphRefreshCoordinator } from "./service/graph-refresh-coordinator.ts";
import { MutationHistoryCoordinator } from "./service/mutation-history-handlers.ts";
import { OPERATION_NAMES, type OperationInputs, type OperationName, type OperationOutputs } from "./service/operations.ts";
import { createPackageSourceHandlers } from "./service/package-source-handlers.ts";
import { createRepoFetchHandlers } from "./service/repo-fetch-handlers.ts";
import { createSymbolGraphHandlers } from "./service/symbol-graph-handlers.ts";
import { type ClosableSymbolIndex, type WarmIndexPoolStatus, type WarmIndexProcessCostRecorder, WarmIndexRegistry } from "./service/warm-index-registry.ts";
import { createWorkspaceFileHandlers } from "./service/workspace-file-handlers.ts";
import { createWorkspaceLifecycleHandlers } from "./service/workspace-lifecycle-handlers.ts";
import { createWorkspaceMapHandler } from "./service/workspace-map-handler.ts";
import type { MutableRegistry } from "./service/workspace-registry.ts";
import { WorkspaceWatchHandlers } from "./service/workspace-watch-handlers.ts";
import type { SourcegraphSearchPort } from "./sourcegraph-search/port.ts";
import { SourcegraphSearchClient } from "./sourcegraph-search/sourcegraph-search-client.ts";
import { ANNOTATION_READ_PERMISSIONS, ANNOTATION_WRITE_PERMISSIONS, registerAnnotationOperations } from "./symbol-annotation/operation-registration.ts";
import type { SymbolAnnotationPort } from "./symbol-annotation/port.ts";
import { InMemorySymbolGraph } from "./symbol-graph/in-memory-symbol-graph.ts";
import type { PopulateSymbolGraphResult } from "./symbol-graph/populate-symbol-graph.ts";
import type { SymbolGraphPort } from "./symbol-graph/port.ts";
import type { TextSearchPort } from "./text-search/port.ts";
import { RipgrepTextSearch } from "./text-search/ripgrep-text-search.ts";
import { lectorVersion } from "./version.ts";
import { PatchRejected } from "./workspace/apply-patch.ts";
import { StaleExpectedHash } from "./workspace/exact-edit.ts";
import { LineEditRace, LineEditRejected } from "./workspace/line-edit.ts";

import type { WorkspacePort } from "./workspace/port.ts";
import { WorkspaceEntryNotFound } from "./workspace/raw-read.ts";

export interface LectorService {
	readonly operations: readonly OperationName[];
	dispatch<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
	/**
	 * The real VehicleRegistry backing the subset of `operations` already migrated onto
	 * defineVehicleOperation/bindVehicleOperation (git, repo cache, mutation-history,
	 * annotations, external-search -- see dispatch-through-registry.ts). Exposed so daemon.ts
	 * can mount @danypops/vehicle-server/http's createVehicleHttpApp under /vehicle/*,
	 * additive alongside the existing /api/v1/ops dispatch -- the same seam Papyrus's own
	 * `service.vehicle` already serves createApp()'s /vehicle/* merge.
	 */
	readonly operationRegistry: VehicleRegistry;
	/** Stops every warm symbol-index subprocess this service spawned. Idempotent. */
	close(): Promise<void>;
	/**
	 * Closes and removes any warm symbol index (e.g. an LSP subprocess) not used within
	 * maxIdleMs. Returns the number reaped. Wired into the daemon's periodic maintenance --
	 * a long-lived, dynamic-workspace daemon that has touched many different projects over
	 * its uptime must not keep every one of their warm indexes alive forever (Oculus's own
	 * TTL-eviction lesson: idle LSP servers are a real, unbounded resource-growth risk, not
	 * a theoretical one).
	 */
	reapIdleSymbolIndexes(maxIdleMs: number): Promise<number>;
	/** Path-free resource status for supervision and capacity diagnostics. */
	symbolIndexPoolStatus(): WarmIndexPoolStatus;
	/**
	 * Samples every currently active warm index's real process tree into the configured
	 * symbolIndexProcessCostCalibrator, if any -- a no-op otherwise. Wired into the daemon's
	 * periodic maintenance, replacing static initial byte estimates with bounded runtime
	 * observation as real language servers actually run.
	 */
	calibrateProcessCosts(): void;
}

export interface LectorServiceOptions {
	/** Threaded into the default LspSymbolIndex's open-file lifecycle and every workspace.populateSymbolGraph run. Defaults to a no-op. */
	logger?: Logger;
	/** Factory for the symbol index backing workspace.findSymbols and code intelligence, given the descriptor resolved for the call. Defaults to an LspSymbolIndex configured for whichever descriptor is passed. */
	createSymbolIndex?: (rootPath: string, descriptor: LanguageServerDescriptor, seedFile?: string) => ClosableSymbolIndex;
	/** Global warm language-server capacity. Defaults to 3. */
	maxActiveSymbolIndexes?: number;
	/** Optional per-language capacities; unspecified languages use the global capacity. */
	symbolIndexLanguageLimits?: Readonly<Record<string, number>>;
	/** Optional adaptive resource strategy layered beneath the fixed process safety ceilings. */
	symbolIndexResourcePolicy?: WarmIndexResourcePolicy;
	/** Warm-index slots populateSymbolGraph alone can never grow the pool into -- interactive queries (findSymbols, goToDefinition, rename, cross-project search) keep the full maxActiveSymbolIndexes; background population queues instead of competing for admission on equal footing. Defaults to 0 (no reservation, today's behavior). */
	reservedForegroundSlots?: number;
	/** The hard structural ceiling a resource policy's own soft ceiling can never raise maxActiveSymbolIndexes past -- independent of memory, protecting against pathological process-count exhaustion. Defaults to 32 (or maxActiveSymbolIndexes if that's already higher). */
	absoluteMaxActiveIndexes?: number;
	/** How long populateSymbolGraph's own admission wait can queue for a slot before giving up with WarmIndexAdmissionQueueTimedOut. Defaults to 10s. */
	backgroundAdmissionQueueTimeoutMs?: number;
	/** How many populateSymbolGraph admissions may be simultaneously queued before a new one fails fast with WarmIndexAdmissionQueueFull. Defaults to 8. */
	maxQueuedBackgroundAdmissions?: number;
	/** Fed real (languageId, pid) samples by calibrateProcessCosts() -- typically the same LanguageServerCostEstimator instance also passed as symbolIndexResourcePolicy's own costEstimator, so calibration and admission read/write the identical live state. */
	symbolIndexProcessCostCalibrator?: WarmIndexProcessCostRecorder;
	/** Shared managed installer for provisionable system-binary language servers. Never used by filesystem-only operations. */
	languageServerProvisioner?: LanguageServerProvisionerPort;
	/**
	 * Explicit opt-in to start with zero registered workspaces, relying entirely on
	 * workspace.registerPath at runtime -- the shape a long-lived background daemon that
	 * attaches to whatever project a host adapter (pi-lector) is used from actually needs.
	 * workspace.registerPath itself now rejects a non-absolute path outright (RelativeWorkspacePath)
	 * rather than resolving it against this process's own irrelevant cwd -- no implicit fallback
	 * reappears just because the registry started empty. Without this option, zero workspaces at
	 * construction is still refused (Locus LCS-BUG-88 class): the default stays "fail loud on
	 * likely misconfiguration," and a caller must say what it actually intends rather than the
	 * guard being silently loosened for everyone.
	 */
	allowDynamicOnly?: boolean;
	/** Factory for the graph backing workspace.populateSymbolGraph/reachableFrom/symbolEdgesFrom/symbolEdgesTo. Defaults to an in-memory graph (not durable across a restart). */
	createSymbolGraph?: (workspaceId: WorkspaceId) => SymbolGraphPort;
	/** Factory for the store backing workspace.createAnnotation/getAnnotation/listAnnotations/refreshAnnotation/scrubAnnotation/restoreAnnotation. Defaults to an in-memory store (not durable across a restart). */
	createSymbolAnnotations?: (workspaceId: WorkspaceId) => SymbolAnnotationPort;
	/** Factory for the store backing workspace.mutationHistory/revertMutation. Defaults to an in-memory store (not durable across a restart), bounded to 50 entries per file. */
	createMutationHistory?: (workspaceId: WorkspaceId) => MutationHistoryPort;
	/** Injectable for tests -- classifyAutoPopulationRoot's own broad-non-project-root heuristic must never depend on the real host machine's actual home directory. Defaults to the real one via node:os. */
	homeDir?: string;
	/** Injectable for tests -- the settle delay populateSymbolGraph's own opt-in retry-on-race loop waits between attempts. Defaults to a real setTimeout-based wait. */
	populateRetrySleep?: (ms: number) => Promise<void>;
	/** Injectable for tests -- the clock populateSymbolGraph's own opt-in retry budget is measured against. Defaults to Date.now. */
	populateRetryNow?: () => number;
	/** Factory for the git port backing workspace.gitStatus/gitLog/gitDiff. Defaults to LocalGit, the real `git` CLI. Cheap to construct -- never cached, unlike symbol indexes. */
	createGitPort?: (rootPath: string) => GitPort;
	/** Factory for the port backing repo.fetch. No default -- unlike createSymbolGraph's safe in-memory fallback, fetching a real external repo always needs a real disk location only a host (daemon.ts) can supply. Called once at construction and reused, not per-call. */
	createRepoFetcher?: () => RepoFetcherPort;
	/** Override package-source resolution. With a repo fetcher configured, the default composes npm lockfiles, registry metadata, and exact Git fetching. */
	createPackageSourceResolver?: () => PackageSourceResolverPort;
	/** Factory for the bookkeeping index backing package.listSources/removeSource/cleanSources -- distinct from RepoFetcherPort's own disk cache, which has no notion of package identity. Defaults to an in-memory store (not durable across a restart), matching every other Lector store's own in-memory-first precedent. Called once at construction and reused. */
	createPackageSourceIndex?: () => PackageSourceIndexPort;
	/** Factory for the npm registry client backing both package.resolveSource's version lookups and search.npmPackages. Defaults to a real NpmRegistryClient. Called once at construction and reused -- tests inject a fixture-server-pointed instance instead of hitting the real registry. */
	createNpmRegistry?: () => NpmRegistryPort;
	/** Factory for the port backing search.githubRepos. Defaults to a real GithubSearchClient (GITHUB_TOKEN if configured, else GitHub's tighter unauthenticated rate limit). Called once at construction and reused. */
	createGithubSearch?: () => GithubSearchPort;
	/** Factory for the port backing search.sourcegraphCode. Defaults to a real SourcegraphSearchClient against public sourcegraph.com. Called once at construction and reused. */
	createSourcegraphSearch?: () => SourcegraphSearchPort;
	/** Factory for each external-search source's own short-TTL result cache. Defaults to a fresh InMemoryExternalSearchCache per source (github/npm/sourcegraph each get their own instance, never shared -- their result shapes differ). */
	createExternalSearchCache?: <T extends object>() => ExternalSearchCachePort<T>;
	/** Factory for the port backing workspace.searchText. Defaults to RipgrepTextSearch -- cheap to construct, no disk dependency, safe like createGitPort's default. Called once at construction and reused. */
	createTextSearch?: () => TextSearchPort;
	/** Factory for the port backing workspace.watch's real OS-level watching. Defaults to NodeFsFileWatcher. Called once per workspace, lazily, on its first active watch -- never for a workspace nobody has asked to watch. */
	createFileWatcher?: () => FileWatcherPort;
	/** Publishes a real file-change event to workspace.watch's own PushChannel topic. Defaults to a no-op -- a host without a real push transport (most embedders, most tests) still gets correct watch registration/matching, just no actual delivery. Wired to a real PushChannel.publish by daemon.ts. */
	publish?: (topic: string, payload: unknown) => void;
	/** Factory for workspace.searchText's result cache. Defaults to an in-memory-only InMemorySearchCache -- safe, no disk dependency. A host wanting the disk-backed tier too (surviving a restart) supplies a TieredSearchCache here. Called once at construction and reused. */
	createSearchCache?: () => SearchCachePort;
	/**
	 * The one hash-addressed content registry shared by rawRead/exactEdit, the default
	 * LspSymbolIndex, and TreeSitterSymbolIndex -- the same physical file read or written by any
	 * of them warms one entry the others reuse, instead of each independently reading/caching (or
	 * not caching at all) its own private view of the same bytes. A caller-supplied
	 * createSymbolIndex factory does not automatically receive this instance -- it owns its own
	 * construction. Defaults to a process-wide in-memory cache.
	 */
	createContentCache?: () => ContentCachePort;
	/** Process-lifetime background executor. Tests inject deterministic ids and tighter bounds. */
	createJobExecutor?: () => BoundedJobExecutor<PopulateSymbolGraphResult>;
	/** Debounce window before a real file change under a graph-watched workspace triggers an automatic re-population. Default 1000ms; tests use a much smaller value for speed. */
	graphRefreshDebounceMs?: number;
}

type OperationHandlers = {
	[Name in OperationName]: (registry: MutableRegistry, input: OperationInputs[Name]) => Promise<OperationOutputs[Name]>;
};

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Create the Lector service over an explicit initial registry of workspaces.
 * Refuses to start with zero registered workspaces -- fails loudly at
 * construction (before the daemon ever binds a listener) rather than
 * starting and returning empty/error results per call later.
 * (Locus LCS-BUG-88 class.) The registry grows at runtime only through
 * workspace.registerPath; there is still no operation that guesses a target
 * from anything other than an explicit id or an explicit path.
 */
export function createLectorService(workspaces: ReadonlyMap<WorkspaceId, WorkspacePort>, options: LectorServiceOptions = {}): LectorService {
	if (workspaces.size === 0 && !options.allowDynamicOnly) {
		throw new Error(
			"Lector service requires at least one registered workspace; refusing to start with none " +
				"(pass options.allowDynamicOnly if this daemon intentionally registers workspaces only via workspace.registerPath at runtime)",
		);
	}
	const registry: MutableRegistry = new Map(Array.from(workspaces, ([id, port]) => [id, { port, origin: "local" as const }]));
	const logger = options.logger ?? NOOP_LOGGER;
	let nextJobId = 0;
	const jobs =
		options.createJobExecutor?.() ??
		new BoundedJobExecutor<PopulateSymbolGraphResult>({
			maxConcurrent: 2,
			maxQueued: 32,
			maxRetained: 128,
			retentionMs: 10 * 60 * 1000,
			createId: () => `job-${Date.now().toString(36)}-${(++nextJobId).toString(36)}`,
			logger,
		});

	// The one hash-addressed content registry shared by rawRead/exactEdit and the DEFAULT
	// LspSymbolIndex/TreeSitterSymbolIndex construction below -- process-wide, not per-workspace,
	// matching ContentCachePort's own content-addressed design (identical bytes share one entry
	// regardless of which file or workspace they came from). A caller-supplied createSymbolIndex
	// owns its own construction and does not automatically receive this instance.
	const contentCache = options.createContentCache?.() ?? new InMemoryContentCache();

	const createSymbolIndex =
		options.createSymbolIndex ??
		((rootPath: string, descriptor: LanguageServerDescriptor, seedFile?: string) => {
			const semantic = new LspSymbolIndex(rootPath, descriptor, seedFile, { contentCache, logger, provisioner: options.languageServerProvisioner });
			if (descriptor.languageId !== "typescript") return semantic;
			return new FallbackCodeIntelligenceIndex(semantic, [new TypeScriptCompilerSymbolIndex(rootPath), new TreeSitterSymbolIndex(rootPath, contentCache)]);
		});
	const warmIndexes = new WarmIndexRegistry<WorkspaceId>({
		descriptors: LANGUAGE_SERVER_DESCRIPTORS,
		createIndex: createSymbolIndex,
		maxActive: options.maxActiveSymbolIndexes,
		languageLimits: options.symbolIndexLanguageLimits,
		resourcePolicy: options.symbolIndexResourcePolicy,
		reservedForegroundSlots: options.reservedForegroundSlots,
		absoluteMaxActiveIndexes: options.absoluteMaxActiveIndexes,
		backgroundAdmissionQueueTimeoutMs: options.backgroundAdmissionQueueTimeoutMs,
		maxQueuedBackgroundAdmissions: options.maxQueuedBackgroundAdmissions,
		processCostCalibrator: options.symbolIndexProcessCostCalibrator,
		observe: (event) => {
			if (event.kind === "close-failed") logger.warn("failed to close symbol index", event);
			else if (event.kind === "admission-evicted") logger.info("evicted idle symbol index for admission", event);
			else if (event.kind === "resource-pressure-evicted") logger.info("evicted idle symbol index under resource pressure", event);
			else logger.info("replaced dead symbol index", event);
		},
		resolveRoot: (workspaceId) => {
			const entry = registry.get(workspaceId);
			if (!entry) throw new UnknownWorkspace(workspaceId);
			if (!entry.rootPath) throw new SymbolQueryUnavailable(workspaceId);
			return entry.rootPath;
		},
		unsupportedLanguage: (path) => new UnsupportedLanguage(path),
	});

	const graphRefresh = new GraphRefreshCoordinator<WorkspaceId, string>({
		createGraph: options.createSymbolGraph ?? (() => new InMemorySymbolGraph()),
		debounceMs: options.graphRefreshDebounceMs ?? 1000,
		logger,
	});
	const ensureSymbolGraph = (workspaceId: WorkspaceId): SymbolGraphPort => graphRefresh.graph(workspaceId);

	const annotationHandlers = new AnnotationHandlers({ registry, graph: ensureSymbolGraph, createStore: options.createSymbolAnnotations });
	const mutationHistory = new MutationHistoryCoordinator({ registry, createStore: options.createMutationHistory, fileOperations: warmIndexes });

	const createGitPort = options.createGitPort ?? ((rootPath: string) => new LocalGit(rootPath));
	// Constructed once, not per-call -- reconstructing would rehydrate the same on-disk index
	// every time, wastefully, and would risk losing the in-memory LRU's recency ordering
	// between calls for no benefit (the index itself is what makes rehydration correct at all).
	const repoFetcher = options.createRepoFetcher?.();
	const npmRegistry = options.createNpmRegistry?.() ?? new NpmRegistryClient();
	const packageSourceResolver =
		options.createPackageSourceResolver?.() ??
		(repoFetcher ? new NpmPackageSourceResolver({ versions: new NpmLockfileVersionResolver(), registry: npmRegistry, repositories: repoFetcher }) : undefined);
	const packageSourceIndex = options.createPackageSourceIndex?.() ?? new InMemoryPackageSourceIndex();
	const githubSearch = options.createGithubSearch?.() ?? new GithubSearchClient();
	const sourcegraphSearch = options.createSourcegraphSearch?.() ?? new SourcegraphSearchClient();
	const createExternalSearchCache = options.createExternalSearchCache ?? (<T extends object>() => new InMemoryExternalSearchCache<T>());
	const githubSearchCache = createExternalSearchCache<GithubRepoSearchResult>();
	const npmSearchCache = createExternalSearchCache<{ candidates: readonly NpmPackageCandidate[] }>();
	const sourcegraphSearchCache = createExternalSearchCache<{ candidates: readonly SourcegraphCodeCandidate[] }>();
	const textSearch = options.createTextSearch?.() ?? new RipgrepTextSearch();
	const searchCache = options.createSearchCache?.() ?? new InMemorySearchCache();
	const createFileWatcher = options.createFileWatcher ?? (() => new NodeFsFileWatcher());
	const publish = options.publish ?? (() => {});
	/** Serializes workspace.rename's atomic multi-file apply per workspace root -- a concurrent second rename (or reference-based rename) for the same workspace waits its turn rather than interleaving mid-apply. */
	const renameMutationBarrier = new SerialExecutionQueue();

	// symbolGraphHandlers and workspaceWatchHandlers are mutually dependent: populateSymbolGraph
	// needs to arm the OS watcher once a workspace is first populated, and the watcher needs to
	// trigger a fresh population on a later file change. Broken with a late-bound indirection --
	// symbolGraphHandlers gets a callback that starts as a no-op and is rebound to the real
	// ensureOsWatcher once workspaceWatchHandlers exists (both constructions below are
	// synchronous, so the rebind always lands before any real call could occur).
	let ensureOsWatcher: (workspaceId: WorkspaceId, rootPath: string) => void = () => {};
	const symbolGraphHandlers = createSymbolGraphHandlers({
		registry,
		warmIndexes,
		graphRefresh,
		repoFetcher,
		createGitPort,
		jobs,
		logger,
		renameMutationBarrier,
		publish,
		mutationHistory,
		homeDir: options.homeDir,
		sleep: options.populateRetrySleep,
		now: options.populateRetryNow,
		ensureOsWatcher: (workspaceId, rootPath) => ensureOsWatcher(workspaceId, rootPath),
	});
	const workspaceWatchHandlers = new WorkspaceWatchHandlers({
		registry,
		createWatcher: createFileWatcher,
		publish,
		notifyWarmIndexes: (workspaceId, event) => warmIndexes.notifyFileChanged(workspaceId, event),
		closeWarmIndexForRootMarkerChange: (workspaceId, changedPath) => warmIndexes.closeForRootMarkerChange(workspaceId, changedPath),
		isGraphWatched: (workspaceId) => graphRefresh.isWatched(workspaceId),
		scheduleGraphRefresh: (workspaceId) => {
			graphRefresh.schedule(workspaceId, () => symbolGraphHandlers.scheduleGraphRefresh(workspaceId));
		},
	});
	ensureOsWatcher = (workspaceId, rootPath) => workspaceWatchHandlers.ensureOsWatcher(workspaceId, rootPath);
	const workspaceLifecycleHandlers = createWorkspaceLifecycleHandlers({ registry, warmIndexes, graphRefresh, watchHandlers: workspaceWatchHandlers });
	const gitHandlers = createGitHandlers({ registry, createGitPort, logger });
	// Registered Git contracts override only their matching direct handlers.
	const operationRegistry = new VehicleRegistry({
		name: "lector",
		version: lectorVersion(),
		description: "Lector's operation registry.",
	});
	registerGitOperations(operationRegistry, registry, gitHandlers);
	const registryGitHandlers: Pick<OperationHandlers, "workspace.gitStatus" | "workspace.gitLog" | "workspace.gitDiff"> = {
		"workspace.gitStatus": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "workspace.gitStatus", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitLog": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "workspace.gitLog", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitDiff": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "workspace.gitDiff", 1, input, GIT_READ_PERMISSIONS),
	};
	const repoFetchHandlers = createRepoFetchHandlers({ repoFetcher, logger });
	registerRepoFetchOperations(operationRegistry, registry, repoFetchHandlers);
	const registryRepoFetchHandlers: Pick<OperationHandlers, "repo.fetch" | "repo.listCache" | "repo.evictCache"> = {
		"repo.fetch": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "repo.fetch", 1, input, REPO_WRITE_PERMISSIONS),
		"repo.listCache": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "repo.listCache", 1, input, REPO_LIST_CACHE_PERMISSIONS),
		"repo.evictCache": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "repo.evictCache", 1, input, REPO_WRITE_PERMISSIONS),
	};
	registerMutationHistoryOperations(operationRegistry, registry, mutationHistory.handlers);
	const registryMutationHistoryHandlers: Pick<
		OperationHandlers,
		"workspace.mutationHistory" | "workspace.revertMutation" | "workspace.mutationTransaction" | "workspace.revertMutationTransaction"
	> = {
		"workspace.mutationHistory": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "workspace.mutationHistory", 1, input, MUTATION_HISTORY_READ_PERMISSIONS),
		"workspace.revertMutation": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "workspace.revertMutation", 1, input, MUTATION_HISTORY_WRITE_PERMISSIONS),
		"workspace.mutationTransaction": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "workspace.mutationTransaction", 1, input, MUTATION_HISTORY_READ_PERMISSIONS),
		"workspace.revertMutationTransaction": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "workspace.revertMutationTransaction", 1, input, MUTATION_HISTORY_WRITE_PERMISSIONS),
	};
	registerAnnotationOperations(operationRegistry, registry, annotationHandlers);
	type AnnotationOperationName =
		| "workspace.createAnnotation"
		| "workspace.getAnnotation"
		| "workspace.listAnnotations"
		| "workspace.refreshAnnotation"
		| "workspace.scrubAnnotation"
		| "workspace.restoreAnnotation"
		| "workspace.containAnnotation"
		| "workspace.uncontainAnnotation"
		| "workspace.annotationTree";
	const dispatchAnnotationOperation = <Name extends AnnotationOperationName>(name: Name, permissions: readonly string[]) =>
		((_registry: MutableRegistry, input: OperationInputs[Name]) => dispatchThroughOperationRegistry(operationRegistry, name, 1, input, permissions)) satisfies (
			registry: MutableRegistry,
			input: OperationInputs[Name],
		) => Promise<OperationOutputs[Name]>;
	const registryAnnotationHandlers: Pick<OperationHandlers, AnnotationOperationName> = {
		"workspace.createAnnotation": dispatchAnnotationOperation("workspace.createAnnotation", ANNOTATION_WRITE_PERMISSIONS),
		"workspace.getAnnotation": dispatchAnnotationOperation("workspace.getAnnotation", ANNOTATION_READ_PERMISSIONS),
		"workspace.listAnnotations": dispatchAnnotationOperation("workspace.listAnnotations", ANNOTATION_READ_PERMISSIONS),
		"workspace.refreshAnnotation": dispatchAnnotationOperation("workspace.refreshAnnotation", ANNOTATION_WRITE_PERMISSIONS),
		"workspace.scrubAnnotation": dispatchAnnotationOperation("workspace.scrubAnnotation", ANNOTATION_WRITE_PERMISSIONS),
		"workspace.restoreAnnotation": dispatchAnnotationOperation("workspace.restoreAnnotation", ANNOTATION_WRITE_PERMISSIONS),
		"workspace.containAnnotation": dispatchAnnotationOperation("workspace.containAnnotation", ANNOTATION_WRITE_PERMISSIONS),
		"workspace.uncontainAnnotation": dispatchAnnotationOperation("workspace.uncontainAnnotation", ANNOTATION_WRITE_PERMISSIONS),
		"workspace.annotationTree": dispatchAnnotationOperation("workspace.annotationTree", ANNOTATION_READ_PERMISSIONS),
	};
	const packageSourceHandlers = createPackageSourceHandlers({ packageSourceResolver, packageSourceIndex, repoFetcher, logger });
	const externalSearchHandlers = createExternalSearchHandlers({
		githubSearch,
		npmRegistry,
		sourcegraphSearch,
		githubSearchCache,
		npmSearchCache,
		sourcegraphSearchCache,
	});
	registerExternalSearchOperations(operationRegistry, registry, externalSearchHandlers);
	const registryExternalSearchHandlers: Pick<OperationHandlers, "search.githubRepos" | "search.npmPackages" | "search.sourcegraphCode"> = {
		"search.githubRepos": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "search.githubRepos", 1, input, EXTERNAL_SEARCH_PERMISSIONS),
		"search.npmPackages": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "search.npmPackages", 1, input, EXTERNAL_SEARCH_PERMISSIONS),
		"search.sourcegraphCode": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "search.sourcegraphCode", 1, input, EXTERNAL_SEARCH_PERMISSIONS),
	};
	const codeIntelligenceHandlers = createCodeIntelligenceHandlers({ warmIndexes });
	const workspaceFileHandlers = createWorkspaceFileHandlers({ contentCache, mutationHistory, warmIndexes, textSearch, searchCache });
	const crossWorkspaceHandlers = createCrossWorkspaceHandlers({
		registry,
		findSymbols: (input) => codeIntelligenceHandlers["workspace.findSymbols"](registry, input),
		searchText: (input) => workspaceFileHandlers["workspace.searchText"](registry, input),
	});

	const workspaceMapHandler = createWorkspaceMapHandler(ensureSymbolGraph);

	const handlers: OperationHandlers = {
		...workspaceFileHandlers,
		...workspaceLifecycleHandlers,
		...codeIntelligenceHandlers,
		...symbolGraphHandlers.handlers,
		...gitHandlers,
		...registryGitHandlers,
		...repoFetchHandlers,
		...registryRepoFetchHandlers,
		...packageSourceHandlers,
		...mutationHistory.handlers,
		...registryMutationHistoryHandlers,
		...annotationHandlers.handlers,
		...registryAnnotationHandlers,
		...registryExternalSearchHandlers,
		...crossWorkspaceHandlers,
		...workspaceWatchHandlers.handlers,
		"workspace.map": workspaceMapHandler,
	};

	return {
		operations: OPERATION_NAMES,
		operationRegistry,
		// Declared `async` deliberately, not just typed `Promise<...>`: a handler (e.g.
		// resolveWorkspace's UnknownWorkspace) can throw synchronously, and only an `async`
		// function body converts a synchronous throw into a rejected promise automatically.
		// Without it, `dispatch` would sometimes throw and sometimes reject depending on
		// which operation ran -- a broken contract for any in-process caller (standalone
		// mode, a future Alef adapter) that isn't protected by the HTTP layer's try/catch.
		async dispatch<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
			const handler = handlers[operation] as (registry: MutableRegistry, input: OperationInputs[Name]) => Promise<OperationOutputs[Name]>;
			return handler(registry, input);
		},
		async close(): Promise<void> {
			jobs.close();
			workspaceWatchHandlers.close();
			await Promise.all([warmIndexes.closeAll(), graphRefresh.close(), annotationHandlers.close()]);
		},
		async reapIdleSymbolIndexes(maxIdleMs: number): Promise<number> {
			return warmIndexes.reapIdle(maxIdleMs);
		},
		symbolIndexPoolStatus(): WarmIndexPoolStatus {
			return warmIndexes.status();
		},
		calibrateProcessCosts(): void {
			warmIndexes.calibrateProcessCosts();
		},
	};
}

export { JobCapacityExceeded, JobNotFound } from "./concurrency/bounded-job-executor.ts";
export type { WorkspaceId } from "./service/errors.ts";
export {
	AnnotationContainmentCycle,
	AnnotationRequiresAnchors,
	BroadNonProjectRoot,
	CodeIntelligenceUnavailable,
	deriveWorkspaceId,
	InvalidJobInput,
	InvalidWorkspaceRoot,
	JobWaitTooLong,
	MutationEntryNotFound,
	MutationRevertStale,
	MutationTransactionNotFound,
	MutationTransactionRevertStale,
	NotAGitRepository,
	PackageSourceEntryInUse,
	PackageSourceResolverNotConfigured,
	ReferenceBasedRenameRequiresFreshGraph,
	RenameNotSupported,
	RepoCacheEntryInUse,
	RepoFetcherNotConfigured,
	SymbolComparisonUnsupportedLanguage,
	SymbolQueryUnavailable,
	UnknownAnnotationAnchor,
	UnknownAnnotationForContainment,
	UnknownWorkspace,
	UnsupportedJobOperation,
	UnsupportedLanguage,
	WorkspaceChangedDuringPopulation,
	WorkspaceReleaseBlocked,
} from "./service/errors.ts";
export type { OperationInputs, OperationName, OperationOutputs } from "./service/operations.ts";
export { OPERATION_NAMES } from "./service/operations.ts";
export type { ClosableSymbolIndex, WarmIndexProcessCostRecorder } from "./service/warm-index-registry.ts";
export type { MutableRegistry, RegisteredWorkspace } from "./service/workspace-registry.ts";
export { resolveFileTree, resolveWorkspace, WorkspaceDoesNotSupportFileTree } from "./service/workspace-registry.ts";
export { LineEditRace, LineEditRejected, PatchRejected, RelativeWorkspacePath, StaleExpectedHash, WatchLimitExceeded, WorkspaceEntryNotFound };
