import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { VehicleRegistry } from "@danypops/vehicle-server";
import type { Logger } from "@danypops/vehicle-server/logging";
import {
	CODE_ACTION_APPLY_PERMISSIONS,
	CODE_ACTION_PREVIEW_PERMISSIONS,
	registerCodeActionOperations,
} from "./code-intelligence/code-action-operation-registration.ts";
import { diagnosticDelta } from "./code-intelligence/diagnostic-delta.ts";
import { FallbackCodeIntelligenceIndex } from "./code-intelligence/fallback-code-intelligence-index.ts";
import { LANGUAGE_SERVER_DESCRIPTORS, type LanguageServerDescriptor } from "./code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "./code-intelligence/lsp/lsp-symbol-index.ts";
import { TreeSitterSymbolIndex } from "./code-intelligence/tree-sitter/tree-sitter-symbol-index.ts";
import { wasmPathForExtension } from "./code-intelligence/tree-sitter/typescript-parser.ts";
import { TypeScriptCompilerSymbolIndex } from "./code-intelligence/typescript-compiler-symbol-index.ts";
import type { WarmIndexResourcePolicy } from "./code-intelligence/warm-index-resource-policy.ts";
import { BoundedJobExecutor } from "./concurrency/bounded-job-executor.ts";
import { SerialExecutionQueue } from "./concurrency/serial-execution-queue.ts";
import { InMemoryContentCache } from "./content-cache/in-memory-content-cache.ts";
import type { ContentCachePort } from "./content-cache/port.ts";
import { CratesIoPackageSourceResolver } from "./crates-io-registry/crates-io-package-source-resolver.ts";
import { CratesIoRegistryClient } from "./crates-io-registry/crates-io-registry-client.ts";
import type { CratesIoRegistryPort } from "./crates-io-registry/port.ts";
import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeSearchResult } from "./external-search/external-search-result.ts";
import { EXTERNAL_SEARCH_PERMISSIONS, registerExternalSearchOperations } from "./external-search/operation-registration.ts";
import { InMemoryExternalSearchCache } from "./external-search-cache/in-memory-external-search-cache.ts";
import type { ExternalSearchCachePort } from "./external-search-cache/port.ts";
import { NodeFsFileWatcher } from "./file-watcher/node-fs-file-watcher.ts";
import type { FileWatcherPort } from "./file-watcher/port.ts";
import { WatchLimitExceeded } from "./file-watcher/watch-registry.ts";
import { LocalGit } from "./git/local-git.ts";
import { GIT_READ_PERMISSIONS, GIT_WORKTREE_WRITE_PERMISSIONS, registerGitOperations } from "./git/operation-registration.ts";
import type { GitPort } from "./git/port.ts";
import { GithubSearchClient } from "./github-search/github-search-client.ts";
import type { GithubSearchPort } from "./github-search/port.ts";
import { GoModuleSourceResolver } from "./go-module-registry/go-module-source-resolver.ts";
import { GoProxyClient } from "./go-module-registry/go-proxy-client.ts";
import { GoModuleLockfileVersionResolver } from "./go-module-version-resolver/go-module-lockfile-version-resolver.ts";
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
import { WORKSPACE_WRITE_PERMISSION } from "./operation-dispatch/permissions.ts";
import { CompositePackageSourceResolver } from "./package-source/composite-package-source-resolver.ts";
import { InMemoryPackageSourceIndex } from "./package-source/in-memory-package-source-index.ts";
import type { PackageSourceIndexPort } from "./package-source/index-port.ts";
import type { PackageSourceResolverPort } from "./package-source/resolver-port.ts";
import { RelativeWorkspacePath } from "./path-safety/assert-absolute-path.ts";
import type { PypiRegistryPort } from "./pypi-registry/port.ts";
import { PypiPackageSourceResolver } from "./pypi-registry/pypi-package-source-resolver.ts";
import { PypiRegistryClient } from "./pypi-registry/pypi-registry-client.ts";
import { PythonLockfileVersionResolver } from "./python-package-version-resolver/python-lockfile-version-resolver.ts";
import { REPO_LIST_CACHE_PERMISSIONS, REPO_WRITE_PERMISSIONS, registerRepoFetchOperations } from "./repo-fetcher/operation-registration.ts";
import type { RepoFetcherPort } from "./repo-fetcher/port.ts";
import { RustCargoLockVersionResolver } from "./rust-crate-version-resolver/rust-cargo-lock-version-resolver.ts";
import { InMemorySearchCache } from "./search-cache/in-memory-search-cache.ts";
import type { SearchCachePort } from "./search-cache/port.ts";
import { type AnnotationHandlerDeps, AnnotationHandlers } from "./service/annotation-handlers.ts";
import { DISPATCH_SLOW_WARN_THRESHOLD_MS } from "./service/bounds.ts";
import { CodeActionHandlers } from "./service/code-action-handler.ts";
import { createCodeIntelligenceHandlers } from "./service/code-intelligence-handlers.ts";
import { createCrossWorkspaceHandlers } from "./service/cross-workspace-handlers.ts";
import { createDiagnosticDeltaHandler } from "./service/diagnostic-delta-handler.ts";
import { DiagnosticValidationCoordinator } from "./service/diagnostic-validation-coordinator.ts";
import { deriveWorkspaceId, SymbolQueryUnavailable, UnknownWorkspace, UnsupportedLanguage, type WorkspaceId } from "./service/errors.ts";
import { createExternalSearchHandlers } from "./service/external-search-handlers.ts";
import { createGitHandlers } from "./service/git-handlers.ts";
import { createGitWorktreeHandlers } from "./service/git-worktree-handlers.ts";
import { GraphRefreshCoordinator } from "./service/graph-refresh-coordinator.ts";
import { createImpactAnalysisHandler } from "./service/impact-analysis-handler.ts";
import { createLocalizeContextHandler } from "./service/localize-context-handler.ts";
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
import { FffIndexedTextEngineFactory } from "./text-search/fff-indexed-text-engine.ts";
import { IndexedTextSearch } from "./text-search/indexed-text-search.ts";
import type { TextSearchPort } from "./text-search/port.ts";
import { RipgrepTextSearch } from "./text-search/ripgrep-text-search.ts";
import { lectorVersion } from "./version.ts";
import { PatchRejected } from "./workspace/apply-patch.ts";
import { StaleExpectedHash } from "./workspace/exact-edit.ts";
import { LineEditRace, LineEditRejected } from "./workspace/line-edit.ts";
import { registerWorkspaceLifecycleOperations } from "./workspace/operation-registration.ts";

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
	/** Warm-index slots populateSymbolGraph alone can never grow the pool into -- interactive queries keep the full maxActiveSymbolIndexes. Defaults to 1 when capacity exceeds one, otherwise 0. */
	reservedForegroundSlots?: number;
	/** The hard structural ceiling a resource policy's own soft ceiling can never raise maxActiveSymbolIndexes past -- independent of memory, protecting against pathological process-count exhaustion. Defaults to 32 (or maxActiveSymbolIndexes if that's already higher). */
	absoluteMaxActiveIndexes?: number;
	/** How long populateSymbolGraph's own admission wait can queue for a slot before giving up with WarmIndexAdmissionQueueTimedOut. Defaults to 10s. */
	backgroundAdmissionQueueTimeoutMs?: number;
	/** How many populateSymbolGraph admissions may be simultaneously queued before a new one fails fast with WarmIndexAdmissionQueueFull. Defaults to 8. */
	maxQueuedBackgroundAdmissions?: number;
	/** How long an interactive semantic query may wait for a sibling foreground lease to free before failing explicitly. Defaults to 10s; zero restores fail-fast capacity errors. */
	foregroundAdmissionQueueTimeoutMs?: number;
	/** Maximum concurrent interactive semantic queries waiting for capacity. Defaults to 8. */
	maxQueuedForegroundAdmissions?: number;
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
	/** Base directory workspace.gitWorktreeAdd creates its own detached worktrees under, one subdirectory per source repo. Defaults to a real OS tmpdir; daemon.ts overrides it to a sibling of GitRepoFetcher's own reposDirectory so both live under the same bounded data root. */
	worktreesRoot?: string;
	/** Factory for the port backing repo.fetch. No default -- unlike createSymbolGraph's safe in-memory fallback, fetching a real external repo always needs a real disk location only a host (daemon.ts) can supply. Called once at construction and reused, not per-call. */
	createRepoFetcher?: () => RepoFetcherPort;
	/** Override package-source resolution. With a repo fetcher configured, the default composes npm lockfiles, registry metadata, and exact Git fetching. */
	createPackageSourceResolver?: () => PackageSourceResolverPort;
	/** Factory for the bookkeeping index backing package.listSources/removeSource/cleanSources -- distinct from RepoFetcherPort's own disk cache, which has no notion of package identity. Defaults to an in-memory store (not durable across a restart), matching every other Lector store's own in-memory-first precedent. Called once at construction and reused. */
	createPackageSourceIndex?: () => PackageSourceIndexPort;
	/** Factory for the npm registry client backing both package.resolveSource's version lookups and search.npmPackages. Defaults to a real NpmRegistryClient. Called once at construction and reused -- tests inject a fixture-server-pointed instance instead of hitting the real registry. */
	createNpmRegistry?: () => NpmRegistryPort;
	/** Factory for the PyPI registry client backing package.resolveSource's own PyPI version lookups. Defaults to a real PypiRegistryClient. Called once at construction and reused -- tests inject a fixture-server-pointed instance instead of hitting the real registry. */
	createPypiRegistry?: () => PypiRegistryPort;
	/** Factory for the GOPROXY client backing package.resolveSource's own Go module existence checks. Defaults to a real GoProxyClient against proxy.golang.org. Called once at construction and reused -- tests inject a fixture-server-pointed instance instead of hitting the real proxy. */
	createGoProxy?: () => GoProxyClient;
	/** Factory for the crates.io registry client backing package.resolveSource's own Rust crate repository lookups. Defaults to a real CratesIoRegistryClient. Called once at construction and reused -- tests inject a fixture-server-pointed instance instead of hitting the real registry. */
	createCratesIoRegistry?: () => CratesIoRegistryPort;
	/** Factory for the port backing search.githubRepos. Defaults to a real GithubSearchClient (GITHUB_TOKEN if configured, else GitHub's tighter unauthenticated rate limit). Called once at construction and reused. */
	createGithubSearch?: () => GithubSearchPort;
	/** Factory for the port backing search.sourcegraphCode. Defaults to a real SourcegraphSearchClient against public sourcegraph.com. Called once at construction and reused. */
	createSourcegraphSearch?: () => SourcegraphSearchPort;
	/** Factory for each external-search source's own short-TTL result cache. Defaults to a fresh InMemoryExternalSearchCache per source (github/npm/sourcegraph each get their own instance, never shared -- their result shapes differ). */
	createExternalSearchCache?: <T extends object>() => ExternalSearchCachePort<T>;
	/** Factory for the port backing workspace.searchText. Defaults to bounded FFF indexing with ripgrep fallback. Called once at construction and reused. */
	createTextSearch?: () => TextSearchPort;
	/** Maximum concurrent resident lexical-index builds. Defaults to 1. */
	maxConcurrentTextIndexBuilds?: number;
	/** Maximum queued resident lexical-index builds. Defaults to 8. */
	maxQueuedTextIndexBuilds?: number;
	/** Maximum workspaces retaining resident lexical-index state. Defaults to 64. */
	maxTrackedTextIndexes?: number;
	/** Per-build deadline. Defaults to 120 seconds. */
	textIndexBuildTimeoutMs?: number;
	/** Per-query native search deadline. Defaults to 5 seconds. */
	textIndexSearchTimeoutMs?: number;
	/** Daemon-owned root for bounded persisted freshness identities. */
	textIndexCacheRoot?: string;
	/** Maximum files admitted to one resident lexical index. Defaults to 100,000. */
	textIndexMaxFiles?: number;
	/** Maximum aggregate source bytes admitted to one resident lexical index. Defaults to 2 GiB. */
	textIndexMaxSourceBytes?: number;
	/** Maximum individual source-file bytes admitted to one resident lexical index. Defaults to 16 MiB. */
	textIndexMaxSingleFileBytes?: number;
	/** Maximum persisted freshness identities. Defaults to 64. */
	textIndexMaxPersistedIdentities?: number;
	/** Maximum aggregate JSON bytes for persisted freshness identities. Defaults to 256 KiB. */
	textIndexMaxPersistedIdentityBytes?: number;
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
	/** Overrides DISPATCH_SLOW_WARN_THRESHOLD_MS -- dispatch()'s own choke-point latency logging. Tests use a tiny value to make the slow-warn path deterministically reachable. */
	dispatchSlowWarnThresholdMs?: number;
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
	const dispatchSlowWarnThresholdMs = options.dispatchSlowWarnThresholdMs ?? DISPATCH_SLOW_WARN_THRESHOLD_MS;
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
			if (descriptor.languageId === "typescript") {
				return new FallbackCodeIntelligenceIndex(semantic, [new TypeScriptCompilerSymbolIndex(rootPath), new TreeSitterSymbolIndex(rootPath, contentCache)]);
			}
			// Every other language falls back to a tree-sitter grammar when one is registered
			// (wasmPathForExtension) -- scoped to that language's own extensions so it never
			// silently reports another language's symbols under this descriptor's own provenance.
			// A language with no registered grammar yet (e.g. Go, Rust, C/C++) has no structural
			// fallback at all: a failed semantic server surfaces its own real error, honestly,
			// rather than a fabricated empty result.
			if (descriptor.extensions.some((extension) => wasmPathForExtension(extension) !== undefined)) {
				return new FallbackCodeIntelligenceIndex(semantic, [
					new TreeSitterSymbolIndex(rootPath, contentCache, {
						language: { languageId: descriptor.languageId, backend: `tree-sitter-${descriptor.languageId}`, extensions: descriptor.extensions },
					}),
				]);
			}
			return semantic;
		});
	const warmIndexes = new WarmIndexRegistry<WorkspaceId>({
		descriptors: LANGUAGE_SERVER_DESCRIPTORS,
		createIndex: createSymbolIndex,
		maxActive: options.maxActiveSymbolIndexes,
		languageLimits: options.symbolIndexLanguageLimits,
		resourcePolicy: options.symbolIndexResourcePolicy,
		reservedForegroundSlots: options.reservedForegroundSlots ?? (options.maxActiveSymbolIndexes === 1 ? 0 : 1),
		absoluteMaxActiveIndexes: options.absoluteMaxActiveIndexes,
		backgroundAdmissionQueueTimeoutMs: options.backgroundAdmissionQueueTimeoutMs,
		maxQueuedBackgroundAdmissions: options.maxQueuedBackgroundAdmissions,
		foregroundAdmissionQueueTimeoutMs: options.foregroundAdmissionQueueTimeoutMs ?? 10_000,
		maxQueuedForegroundAdmissions: options.maxQueuedForegroundAdmissions ?? 8,
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

	// Late-bound the same way ensureOsWatcher is below: AnnotationHandlers is constructed before
	// symbolGraphHandlers (which owns the real cacheStatus/populateSymbolGraph implementations it
	// needs for autoPopulate), but both constructions are synchronous, so the rebind always lands
	// before any real call could occur.
	let annotationCacheStatus: AnnotationHandlerDeps["cacheStatus"] = () => {
		throw new Error("cacheStatus not yet initialized");
	};
	let annotationPopulateSymbolGraph: AnnotationHandlerDeps["populateSymbolGraph"] = () => {
		throw new Error("populateSymbolGraph not yet initialized");
	};
	const annotationHandlers = new AnnotationHandlers({
		registry,
		graph: ensureSymbolGraph,
		createStore: options.createSymbolAnnotations,
		cacheStatus: (registry, input) => annotationCacheStatus(registry, input),
		populateSymbolGraph: (registry, input) => annotationPopulateSymbolGraph(registry, input),
	});
	const mutationHistory = new MutationHistoryCoordinator({ registry, createStore: options.createMutationHistory, fileOperations: warmIndexes });
	const diagnosticValidation = new DiagnosticValidationCoordinator(warmIndexes, ensureSymbolGraph);

	const createGitPort = options.createGitPort ?? ((rootPath: string) => new LocalGit(rootPath));
	// Constructed once, not per-call -- reconstructing would rehydrate the same on-disk index
	// every time, wastefully, and would risk losing the in-memory LRU's recency ordering
	// between calls for no benefit (the index itself is what makes rehydration correct at all).
	const repoFetcher = options.createRepoFetcher?.();
	const npmRegistry = options.createNpmRegistry?.() ?? new NpmRegistryClient();
	const pypiRegistry = options.createPypiRegistry?.() ?? new PypiRegistryClient();
	const goProxy = options.createGoProxy?.() ?? new GoProxyClient();
	const cratesIoRegistry = options.createCratesIoRegistry?.() ?? new CratesIoRegistryClient();
	const packageSourceResolver =
		options.createPackageSourceResolver?.() ??
		(repoFetcher
			? new CompositePackageSourceResolver([
					new NpmPackageSourceResolver({ versions: new NpmLockfileVersionResolver(), registry: npmRegistry, repositories: repoFetcher }),
					new PypiPackageSourceResolver({ versions: new PythonLockfileVersionResolver(), registry: pypiRegistry, repositories: repoFetcher }),
					new GoModuleSourceResolver({ versions: new GoModuleLockfileVersionResolver(), proxy: goProxy, repositories: repoFetcher }),
					new CratesIoPackageSourceResolver({ versions: new RustCargoLockVersionResolver(), registry: cratesIoRegistry, repositories: repoFetcher }),
				])
			: undefined);
	const packageSourceIndex = options.createPackageSourceIndex?.() ?? new InMemoryPackageSourceIndex();
	const githubSearch = options.createGithubSearch?.() ?? new GithubSearchClient();
	const sourcegraphSearch = options.createSourcegraphSearch?.() ?? new SourcegraphSearchClient();
	const createExternalSearchCache = options.createExternalSearchCache ?? (<T extends object>() => new InMemoryExternalSearchCache<T>());
	const githubSearchCache = createExternalSearchCache<GithubRepoSearchResult>();
	const npmSearchCache = createExternalSearchCache<{ candidates: readonly NpmPackageCandidate[] }>();
	const sourcegraphSearchCache = createExternalSearchCache<SourcegraphCodeSearchResult>();
	const textSearch: TextSearchPort =
		options.createTextSearch?.() ??
		new IndexedTextSearch(
			new RipgrepTextSearch(),
			new FffIndexedTextEngineFactory({
				cacheRoot: options.textIndexCacheRoot ?? join(tmpdir(), "lector-text-index-cache"),
				buildTimeoutMs: options.textIndexBuildTimeoutMs ?? 120_000,
				searchTimeoutMs: options.textIndexSearchTimeoutMs ?? 5_000,
				maxFiles: options.textIndexMaxFiles ?? 100_000,
				maxSourceBytes: options.textIndexMaxSourceBytes ?? 2 * 1024 * 1024 * 1024,
				maxSingleFileBytes: options.textIndexMaxSingleFileBytes ?? 16 * 1024 * 1024,
				maxPersistedIdentities: options.textIndexMaxPersistedIdentities ?? 64,
				maxPersistedIdentityBytes: options.textIndexMaxPersistedIdentityBytes ?? 256 * 1024,
			}),
			{
				maxConcurrentBuilds: options.maxConcurrentTextIndexBuilds ?? 1,
				maxQueuedBuilds: options.maxQueuedTextIndexBuilds ?? 8,
				maxTrackedWorkspaces: options.maxTrackedTextIndexes ?? 64,
			},
		);
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
		diagnosticValidation,
		homeDir: options.homeDir,
		sleep: options.populateRetrySleep,
		now: options.populateRetryNow,
		ensureOsWatcher: (workspaceId, rootPath) => ensureOsWatcher(workspaceId, rootPath),
	});
	annotationCacheStatus = symbolGraphHandlers.handlers["workspace.cacheStatus"];
	annotationPopulateSymbolGraph = symbolGraphHandlers.handlers["workspace.populateSymbolGraph"];
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
		invalidateTextSearch: (workspaceId, rootPath) => {
			textSearch.invalidate?.(rootPath);
			void searchCache.invalidateWorkspace(workspaceId);
		},
	});
	ensureOsWatcher = (workspaceId, rootPath) => workspaceWatchHandlers.ensureOsWatcher(workspaceId, rootPath);
	const workspaceLifecycleHandlers = createWorkspaceLifecycleHandlers({
		registry,
		warmIndexes,
		graphRefresh,
		watchHandlers: workspaceWatchHandlers,
		releaseTextSearch: (rootPath) => textSearch.releaseWorkspace?.(rootPath),
	});
	const gitHandlers = createGitHandlers({ registry, createGitPort, logger });
	const gitWorktreeHandlers = createGitWorktreeHandlers({
		registry,
		createGitPort,
		worktreesRoot: options.worktreesRoot ?? join(tmpdir(), "lector-worktrees"),
		releaseWorkspace: workspaceLifecycleHandlers["workspace.release"],
		logger,
	});
	// Registered Git contracts override only their matching direct handlers.
	const operationRegistry = new VehicleRegistry({
		name: "lector",
		version: lectorVersion(),
		description: "Lector's operation registry.",
	});
	registerWorkspaceLifecycleOperations(operationRegistry, registry, workspaceLifecycleHandlers["workspace.release"]);
	const registryWorkspaceLifecycleHandlers: Pick<OperationHandlers, "workspace.release"> = {
		"workspace.release": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "workspace.release", 1, input, [WORKSPACE_WRITE_PERMISSION]),
	};
	registerGitOperations(operationRegistry, registry, gitHandlers, gitWorktreeHandlers);
	const registryGitHandlers: Pick<
		OperationHandlers,
		| "workspace.gitStatus"
		| "workspace.gitLog"
		| "workspace.gitDiff"
		| "workspace.gitShowFile"
		| "workspace.gitGrep"
		| "workspace.gitGrepHistory"
		| "workspace.gitListFiles"
		| "workspace.gitIsAncestor"
		| "workspace.gitWorktreeAdd"
		| "workspace.gitWorktreeRemove"
	> = {
		"workspace.gitStatus": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "workspace.gitStatus", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitLog": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "workspace.gitLog", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitDiff": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "workspace.gitDiff", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitShowFile": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "workspace.gitShowFile", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitGrep": (_registry, input) => dispatchThroughOperationRegistry(operationRegistry, "workspace.gitGrep", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitGrepHistory": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "workspace.gitGrepHistory", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitListFiles": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "workspace.gitListFiles", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitIsAncestor": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "workspace.gitIsAncestor", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitWorktreeAdd": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "workspace.gitWorktreeAdd", 1, input, GIT_WORKTREE_WRITE_PERMISSIONS),
		"workspace.gitWorktreeRemove": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "workspace.gitWorktreeRemove", 1, input, GIT_WORKTREE_WRITE_PERMISSIONS),
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
	const codeActionHandlers = new CodeActionHandlers({
		registry,
		warmIndexes,
		mutationBarrier: renameMutationBarrier,
		mutationHistory,
		diagnosticValidation,
	});
	registerCodeActionOperations(operationRegistry, registry, codeActionHandlers);
	const registryCodeActionHandlers: Pick<OperationHandlers, "workspace.previewCodeActions" | "workspace.applyCodeAction"> = {
		"workspace.previewCodeActions": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "workspace.previewCodeActions", 1, input, CODE_ACTION_PREVIEW_PERMISSIONS),
		"workspace.applyCodeAction": (_registry, input) =>
			dispatchThroughOperationRegistry(operationRegistry, "workspace.applyCodeAction", 1, input, CODE_ACTION_APPLY_PERMISSIONS),
	};
	const workspaceFileHandlers = createWorkspaceFileHandlers({
		contentCache,
		mutationHistory,
		warmIndexes,
		textSearch,
		searchCache,
		prepareTextSearch: (workspaceId, rootPath, origin) => {
			textSearch.registerWorkspace?.(rootPath, origin);
			workspaceWatchHandlers.ensureOsWatcher(workspaceId, rootPath);
		},
	});
	const crossWorkspaceHandlers = createCrossWorkspaceHandlers({
		registry,
		findSymbols: (input) => codeIntelligenceHandlers["workspace.findSymbols"](registry, input),
		searchText: (input) => workspaceFileHandlers["workspace.searchText"](registry, input),
	});

	const workspaceMapHandler = createWorkspaceMapHandler(ensureSymbolGraph);
	const localizeContextHandler = createLocalizeContextHandler(textSearch, ensureSymbolGraph, (workspaceId) =>
		annotationHandlers.storeForWorkspace(workspaceId),
	);
	const impactAnalysisHandler = createImpactAnalysisHandler({
		graph: ensureSymbolGraph,
		createGitPort,
		mutationHistory,
		warmIndexes,
		cacheStatus: symbolGraphHandlers.handlers["workspace.cacheStatus"],
		populateSymbolGraph: symbolGraphHandlers.handlers["workspace.populateSymbolGraph"],
		supertypes: codeIntelligenceHandlers["workspace.supertypes"],
		subtypes: codeIntelligenceHandlers["workspace.subtypes"],
	});
	const diagnosticDeltaHandler = createDiagnosticDeltaHandler(diagnosticValidation, async (input) => {
		if (
			input.maxDepth === undefined ||
			input.maxNodes === undefined ||
			input.maxEdges === undefined ||
			input.deadlineMs === undefined ||
			input.maxFiles === undefined ||
			input.maxSymbolsPerFile === undefined
		) {
			throw new TypeError("git diagnostic delta requires maxDepth, maxNodes, maxEdges, deadlineMs, maxFiles, and maxSymbolsPerFile");
		}
		const impact = await impactAnalysisHandler(registry, {
			workspaceId: input.workspaceId,
			source: input.source,
			maxDepth: input.maxDepth,
			maxNodes: input.maxNodes,
			maxEdges: input.maxEdges,
			maxBytes: input.maxBytes,
			deadlineMs: input.deadlineMs,
			maxFiles: input.maxFiles,
			maxSymbolsPerFile: input.maxSymbolsPerFile,
			...(input.autoPopulate !== undefined ? { autoPopulate: input.autoPopulate } : {}),
		});
		const workspaceEntry = registry.get(input.workspaceId);
		if (!workspaceEntry?.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		const affectedPaths = [
			...new Set([...impact.changedSymbols.map(({ symbol }) => symbol.location.path), ...impact.impactedSymbols.map(({ symbol }) => symbol.location.path)]),
		].sort();
		const worktree = await gitWorktreeHandlers["workspace.gitWorktreeAdd"](registry, {
			workspaceId: input.workspaceId,
			ref: input.source.ref,
		});
		const baselineWorkspaceId = deriveWorkspaceId(worktree.path);
		const baselinePaths = affectedPaths.map((path) => join(worktree.path, relative(workspaceEntry.rootPath ?? "", path)));
		try {
			const [beforeRaw, after] = await Promise.all([
				diagnosticValidation.capture(baselineWorkspaceId, baselinePaths, input.deadlineMs),
				diagnosticValidation.capture(input.workspaceId, affectedPaths, input.deadlineMs),
			]);
			const currentPathByBaseline = new Map(baselinePaths.map((path, index) => [path, affectedPaths[index] ?? path]));
			const before = beforeRaw.files.flatMap((file) =>
				file.diagnostics.map((diagnostic) => ({
					...diagnostic,
					range: { ...diagnostic.range, path: currentPathByBaseline.get(diagnostic.range.path) ?? diagnostic.range.path },
				})),
			);
			const afterDiagnostics = after.files.flatMap((file) => file.diagnostics);
			const provenance = [...beforeRaw.files, ...after.files]
				.flatMap((file) => (file.provenance ? [file.provenance] : []))
				.filter((candidate, index, values) => values.findIndex((value) => JSON.stringify(value) === JSON.stringify(candidate)) === index);
			return {
				source: input.source,
				...diagnosticDelta(before, afterDiagnostics),
				affectedPaths,
				completeness:
					beforeRaw.completeness === "complete" && after.completeness === "complete" && !impact.truncated && !impact.deadlineReached ? "complete" : "partial",
				provenance,
			};
		} finally {
			if (worktree.created) await gitWorktreeHandlers["workspace.gitWorktreeRemove"](registry, { workspaceId: baselineWorkspaceId });
		}
	});

	const handlers: OperationHandlers = {
		...workspaceFileHandlers,
		...workspaceLifecycleHandlers,
		...registryWorkspaceLifecycleHandlers,
		...codeIntelligenceHandlers,
		...registryCodeActionHandlers,
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
		"workspace.localizeContext": localizeContextHandler,
		"workspace.impactAnalysis": impactAnalysisHandler,
		"workspace.diagnosticDelta": diagnosticDeltaHandler,
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
		//
		// Also the one choke point every operation flows through regardless of whether it has
		// migrated onto VehicleRegistry (which gets its own metrics middleware -- daemon.ts's
		// createVehicleMetricsMiddleware -- entirely separately): timing and outcome are logged
		// here unconditionally, so a legacy operation (findSymbols, populateSymbolGraph, rawRead,
		// ...) is not flying blind just because it hasn't been migrated yet. A thrown/rejected
		// error is logged then rethrown completely unchanged -- this must never itself become a
		// second source of truth for what a caller sees, only for what an operator can observe.
		async dispatch<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
			const handler = handlers[operation] as (registry: MutableRegistry, input: OperationInputs[Name]) => Promise<OperationOutputs[Name]>;
			const startedAt = performance.now();
			try {
				const result = await handler(registry, input);
				const durationMs = performance.now() - startedAt;
				const fields = { component: "dispatch", operation, durationMs: Math.round(durationMs) };
				if (durationMs >= dispatchSlowWarnThresholdMs) logger.warn("slow operation", fields);
				else logger.debug("operation completed", fields);
				return result;
			} catch (error) {
				const durationMs = performance.now() - startedAt;
				logger.warn("operation failed", {
					component: "dispatch",
					operation,
					durationMs: Math.round(durationMs),
					code: error instanceof Error ? error.name || "Error" : "Error",
				});
				throw error;
			}
		},
		async close(): Promise<void> {
			jobs.close();
			workspaceWatchHandlers.close();
			textSearch.close?.();
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
export { DiagnosticValidationNotFound } from "./service/diagnostic-delta-handler.ts";
export type { WorkspaceId } from "./service/errors.ts";
export {
	AnnotationContainmentCycle,
	AnnotationRequiresAnchors,
	AutoPopulateRequiresBounds,
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
export { ImpactAnalysisRequiresFreshGraph } from "./service/impact-analysis-handler.ts";
export type { OperationInputs, OperationName, OperationOutputs } from "./service/operations.ts";
export { OPERATION_NAMES } from "./service/operations.ts";
export type { ClosableSymbolIndex, WarmIndexProcessCostRecorder } from "./service/warm-index-registry.ts";
export type { MutableRegistry, RegisteredWorkspace } from "./service/workspace-registry.ts";
export { resolveFileTree, resolveWorkspace, WorkspaceDoesNotSupportFileTree } from "./service/workspace-registry.ts";
export { LineEditRace, LineEditRejected, PatchRejected, RelativeWorkspacePath, StaleExpectedHash, WatchLimitExceeded, WorkspaceEntryNotFound };
