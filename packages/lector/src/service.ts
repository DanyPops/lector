import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { VehicleRegistry } from "@danypops/vehicle-server";
import type { Logger } from "@danypops/vehicle-server/logging";
import { FallbackCodeIntelligenceIndex } from "./code-intelligence/fallback-code-intelligence-index.ts";
import { LANGUAGE_SERVER_DESCRIPTORS, type LanguageServerDescriptor } from "./code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "./code-intelligence/lsp/lsp-symbol-index.ts";
import { TreeSitterSymbolIndex } from "./code-intelligence/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { TypeScriptCompilerSymbolIndex } from "./code-intelligence/typescript-compiler-symbol-index.ts";
import { BoundedJobExecutor } from "./concurrency/bounded-job-executor.ts";
import { SerialExecutionQueue } from "./concurrency/serial-execution-queue.ts";
import { InMemoryContentCache } from "./content-cache/in-memory-content-cache.ts";
import type { ContentCachePort } from "./content-cache/port.ts";
import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeCandidate } from "./external-search/external-search-result.ts";
import { InMemoryExternalSearchCache } from "./external-search-cache/in-memory-external-search-cache.ts";
import type { ExternalSearchCachePort } from "./external-search-cache/port.ts";
import { NodeFsFileWatcher } from "./file-watcher/node-fs-file-watcher.ts";
import type { FileWatcherPort } from "./file-watcher/port.ts";
import { WatchLimitExceeded } from "./file-watcher/watch-registry.ts";
import { LocalGit } from "./git/local-git.ts";
import type { GitPort } from "./git/port.ts";
import { GithubSearchClient } from "./github-search/github-search-client.ts";
import type { GithubSearchPort } from "./github-search/port.ts";
import { NpmLockfileVersionResolver } from "./installed-package-version-resolver/npm-lockfile-version-resolver.ts";
import type { LanguageServerProvisionerPort } from "./lsp-provisioning/port.ts";
import type { MutationHistoryPort } from "./mutation-history/port.ts";
import { NpmPackageSourceResolver } from "./npm-registry/npm-package-source-resolver.ts";
import { NpmRegistryClient } from "./npm-registry/npm-registry-client.ts";
import type { NpmRegistryPort } from "./npm-registry/port.ts";
import { InMemoryPackageSourceIndex } from "./package-source/in-memory-package-source-index.ts";
import type { PackageSourceIndexPort } from "./package-source/index-port.ts";
import type { PackageSourceResolverPort } from "./package-source/resolver-port.ts";
import { assertAbsolutePath, RelativeWorkspacePath } from "./path-safety/assert-absolute-path.ts";
import type { RepoFetcherPort } from "./repo-fetcher/port.ts";
import { InMemorySearchCache } from "./search-cache/in-memory-search-cache.ts";
import type { SearchCachePort } from "./search-cache/port.ts";
import { AnnotationHandlers } from "./service/annotation-handlers.ts";
import { createCodeIntelligenceHandlers } from "./service/code-intelligence-handlers.ts";
import { createCrossWorkspaceHandlers } from "./service/cross-workspace-handlers.ts";
import { deriveWorkspaceId, InvalidWorkspaceRoot, SymbolQueryUnavailable, UnknownWorkspace, UnsupportedLanguage, type WorkspaceId } from "./service/errors.ts";
import { createExternalSearchHandlers } from "./service/external-search-handlers.ts";
import { createGitHandlers } from "./service/git-handlers.ts";
import { GraphRefreshCoordinator } from "./service/graph-refresh-coordinator.ts";
import { MutationHistoryCoordinator } from "./service/mutation-history-handlers.ts";
import { OPERATION_NAMES, type OperationInputs, type OperationName, type OperationOutputs } from "./service/operations.ts";
import { createPackageSourceHandlers } from "./service/package-source-handlers.ts";
import { createRepoFetchHandlers } from "./service/repo-fetch-handlers.ts";
import { createSymbolGraphHandlers } from "./service/symbol-graph-handlers.ts";
import { GIT_READ_PERMISSIONS, registerGitVehicleOperations } from "./service/vehicle/git-operations.ts";
import { dispatchThroughVehicle } from "./service/vehicle/vehicle-dispatch.ts";
import { type ClosableSymbolIndex, WarmIndexRegistry } from "./service/warm-index-registry.ts";
import { createWorkspaceFileHandlers } from "./service/workspace-file-handlers.ts";
import { createWorkspaceMapHandler } from "./service/workspace-map-handler.ts";
import type { MutableRegistry } from "./service/workspace-registry.ts";
import { WorkspaceWatchHandlers } from "./service/workspace-watch-handlers.ts";
import type { SourcegraphSearchPort } from "./sourcegraph-search/port.ts";
import { SourcegraphSearchClient } from "./sourcegraph-search/sourcegraph-search-client.ts";
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
import { LocalFilesystemWorkspace } from "./workspace/local-filesystem-workspace.ts";
import type { WorkspacePort } from "./workspace/port.ts";
import { WorkspaceEntryNotFound } from "./workspace/raw-read.ts";

export interface LectorService {
	readonly operations: readonly OperationName[];
	dispatch<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
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
}

export interface LectorServiceOptions {
	/** Threaded into the default LspSymbolIndex's open-file lifecycle and every workspace.populateSymbolGraph run. Defaults to a no-op. */
	logger?: Logger;
	/** Factory for the symbol index backing workspace.findSymbols and code intelligence, given the descriptor resolved for the call. Defaults to an LspSymbolIndex configured for whichever descriptor is passed. */
	createSymbolIndex?: (rootPath: string, descriptor: LanguageServerDescriptor, seedFile?: string) => ClosableSymbolIndex;
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

async function registerPath(registry: MutableRegistry, input: OperationInputs["workspace.registerPath"]): Promise<OperationOutputs["workspace.registerPath"]> {
	// Rejected outright, not resolved -- a daemon has no caller-relative "current directory" of
	// its own; resolve() on a relative path would silently use this PROCESS's own cwd (e.g. a
	// systemd unit's fixed WorkingDirectory), not whatever the real caller actually meant.
	assertAbsolutePath(input.path);
	const absolutePath = resolve(input.path);
	const workspaceId = deriveWorkspaceId(absolutePath);
	if (registry.has(workspaceId)) {
		return { workspaceId, created: false };
	}

	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(absolutePath);
	} catch {
		throw new InvalidWorkspaceRoot(absolutePath, "path does not exist or is not accessible");
	}
	if (!stats.isDirectory()) {
		throw new InvalidWorkspaceRoot(absolutePath, "path is not a directory");
	}

	registry.set(workspaceId, { port: new LocalFilesystemWorkspace(absolutePath), rootPath: absolutePath, origin: "local" });
	return { workspaceId, created: true };
}

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
		ensureOsWatcher: (workspaceId, rootPath) => ensureOsWatcher(workspaceId, rootPath),
	});
	const workspaceWatchHandlers = new WorkspaceWatchHandlers({
		registry,
		createWatcher: createFileWatcher,
		publish,
		notifyWarmIndexes: (workspaceId, event) => warmIndexes.notifyFileChanged(workspaceId, event),
		isGraphWatched: (workspaceId) => graphRefresh.isWatched(workspaceId),
		scheduleGraphRefresh: (workspaceId) => {
			graphRefresh.schedule(workspaceId, () => {
				void symbolGraphHandlers.scheduleGraphRefresh(workspaceId);
			});
		},
	});
	ensureOsWatcher = (workspaceId, rootPath) => workspaceWatchHandlers.ensureOsWatcher(workspaceId, rootPath);
	const gitHandlers = createGitHandlers({ registry, createGitPort, logger });
	// gitStatus/gitLog/gitDiff route through a VehicleRegistry; every other git operation
	// (compareSymbolAcrossVersions included) still dispatches straight to gitHandlers below.
	const vehicleRegistry = new VehicleRegistry({
		name: "lector",
		version: lectorVersion(),
		description: "Lector's operation dispatch, migrated incrementally onto Vehicle.",
	});
	registerGitVehicleOperations(vehicleRegistry, registry, gitHandlers);
	const vehicleGitHandlers: Pick<OperationHandlers, "workspace.gitStatus" | "workspace.gitLog" | "workspace.gitDiff"> = {
		"workspace.gitStatus": (_registry, input) => dispatchThroughVehicle(vehicleRegistry, "workspace.gitStatus", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitLog": (_registry, input) => dispatchThroughVehicle(vehicleRegistry, "workspace.gitLog", 1, input, GIT_READ_PERMISSIONS),
		"workspace.gitDiff": (_registry, input) => dispatchThroughVehicle(vehicleRegistry, "workspace.gitDiff", 1, input, GIT_READ_PERMISSIONS),
	};
	const repoFetchHandlers = createRepoFetchHandlers({ repoFetcher, logger });
	const packageSourceHandlers = createPackageSourceHandlers({ packageSourceResolver, packageSourceIndex, repoFetcher, logger });
	const externalSearchHandlers = createExternalSearchHandlers({
		githubSearch,
		npmRegistry,
		sourcegraphSearch,
		githubSearchCache,
		npmSearchCache,
		sourcegraphSearchCache,
	});
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
		"workspace.registerPath": registerPath,
		...codeIntelligenceHandlers,
		...symbolGraphHandlers.handlers,
		...gitHandlers,
		...vehicleGitHandlers,
		...repoFetchHandlers,
		...packageSourceHandlers,
		...mutationHistory.handlers,
		...annotationHandlers.handlers,
		...externalSearchHandlers,
		...crossWorkspaceHandlers,
		...workspaceWatchHandlers.handlers,
		"workspace.map": workspaceMapHandler,
	};

	return {
		operations: OPERATION_NAMES,
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
	};
}

export { JobCapacityExceeded, JobNotFound } from "./concurrency/bounded-job-executor.ts";
export type { WorkspaceId } from "./service/errors.ts";
export {
	AnnotationContainmentCycle,
	AnnotationRequiresAnchors,
	CodeIntelligenceUnavailable,
	deriveWorkspaceId,
	InvalidJobInput,
	InvalidWorkspaceRoot,
	JobWaitTooLong,
	MutationEntryNotFound,
	MutationRevertStale,
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
} from "./service/errors.ts";
export type { OperationInputs, OperationName, OperationOutputs } from "./service/operations.ts";
export { OPERATION_NAMES } from "./service/operations.ts";
export type { ClosableSymbolIndex } from "./service/warm-index-registry.ts";
export type { MutableRegistry, RegisteredWorkspace } from "./service/workspace-registry.ts";
export { resolveFileTree, resolveWorkspace, WorkspaceDoesNotSupportFileTree } from "./service/workspace-registry.ts";
export { LineEditRace, LineEditRejected, PatchRejected, RelativeWorkspacePath, StaleExpectedHash, WatchLimitExceeded, WorkspaceEntryNotFound };
