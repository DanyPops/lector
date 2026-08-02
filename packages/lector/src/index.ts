export { type ClosableIntelligenceIndex, FallbackCodeIntelligenceIndex } from "./adapters/fallback-code-intelligence-index.ts";
export { InMemoryWorkspace } from "./adapters/in-memory-workspace.ts";
export { LocalFilesystemWorkspace, PathEscapesWorkspaceRoot } from "./adapters/local-filesystem-workspace.ts";
export {
	LanguageServerCapacityExceeded,
	LanguageServerProcess,
	LanguageServerProcessExited,
	LanguageServerRequestTimedOut,
} from "./adapters/lsp/language-server-process.ts";
export { LanguageFileLimitExceeded, LanguageFileOutsideWorkspace, LspSymbolIndex, type LspSymbolIndexOptions } from "./adapters/lsp/lsp-symbol-index.ts";
export { PolyglotCodeIntelligenceIndex, type PolyglotIndexEntry } from "./adapters/polyglot-code-intelligence-index.ts";
export { ReadOnlyWorkspace, WorkspaceIsReadOnly } from "./adapters/read-only-workspace.ts";
export { deriveSourceManifest, type SourceManifest, SourceManifestLimitExceeded } from "./adapters/source-manifest.ts";
export { TreeSitterSymbolIndex, type TreeSitterSymbolIndexOptions } from "./adapters/tree-sitter/typescript-tree-sitter-symbol-index.ts";
export { TypeScriptCompilerSymbolIndex, type TypeScriptCompilerSymbolIndexOptions } from "./adapters/typescript-compiler-symbol-index.ts";
export {
	type ConnectLectorClientOptions,
	connectLectorClient,
	connectLectorClientAt,
	type LectorClient,
	remoteErrorIs,
	resolveLectorDaemonConnection,
} from "./client.ts";
export { resolveLectorPaths } from "./constants.ts";
export { InMemoryContentCache } from "./content-cache/in-memory-content-cache.ts";
export type { ContentCacheEntry, ContentCachePort, ContentSymbol } from "./content-cache/port.ts";
export { SqliteContentCache } from "./content-cache/sqlite-content-cache.ts";
export { buildLectorApp, type LectorDaemonOptions, serveMain, startLectorDaemon } from "./daemon.ts";
export {
	type ApplyPatchRequest,
	applyPatch,
	PatchRejected,
} from "./domain/apply-patch.ts";
export { applyReferenceBasedRename, type ReferenceBasedRenameOutcome } from "./domain/apply-reference-based-rename.ts";
export { assertSafeGitArgument, UnsafeGitArgument } from "./domain/assert-safe-git-argument.ts";
export { assertSafeGlobPattern, UnsafeGlobPattern } from "./domain/assert-safe-glob-pattern.ts";
export { assertSafePathSegment, UnsafePathSegment } from "./domain/assert-safe-path-segment.ts";
export { assertSafeRepoReference } from "./domain/assert-safe-repo-reference.ts";
export { assertSafeSearchQuery, UnsafeSearchQuery } from "./domain/assert-safe-search-query.ts";
export {
	BoundedJobExecutor,
	type BoundedJobExecutorOptions,
	JobCapacityExceeded,
	JobExecutorClosed,
	JobNotFound,
	type JobPriority,
	type JobSnapshot,
} from "./domain/bounded-job-executor.ts";
export type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "./domain/call-hierarchy.ts";
export type { CodeRange } from "./domain/code-range.ts";
export type { SymbolComparisonStatus, SymbolDeclarationComparison } from "./domain/compare-symbol-declarations.ts";
export { type ContentHash, contentHashOf } from "./domain/content-hash.ts";
export type { Diagnostic, DiagnosticSeverity } from "./domain/diagnostic.ts";
export { diagnostics } from "./domain/diagnostics.ts";
export type { DocumentSymbolEntry } from "./domain/document-symbol.ts";
export { documentSymbols } from "./domain/document-symbols.ts";
export {
	type EditOutcome,
	type ExpectedHashEdit,
	exactEdit,
	StaleExpectedHash,
} from "./domain/exact-edit.ts";
export type {
	ExternalSearchBounds,
	GithubRepoCandidate,
	GithubRepoSearchResult,
	NpmPackageCandidate,
	SourcegraphCodeCandidate,
	SourcegraphLineMatch,
} from "./domain/external-search-result.ts";
export { DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS, splitSourcegraphRepository } from "./domain/external-search-result.ts";
export { findReferences } from "./domain/find-references.ts";
export { findWorkspaceSymbols } from "./domain/find-workspace-symbols.ts";
export { goToDefinition } from "./domain/go-to-definition.ts";
export { goToImplementation } from "./domain/go-to-implementation.ts";
export type { Hover } from "./domain/hover.ts";
export { hoverAt } from "./domain/hover-at.ts";
export { incomingCalls } from "./domain/incoming-calls.ts";
export type {
	IntelligenceFidelity,
	IntelligenceProvenance,
	IntelligenceSourceOutcome,
	ProvenancedResult,
	SymbolSearchBounds,
} from "./domain/intelligence-provenance.ts";
export {
	descriptorForExtension,
	LANGUAGE_SERVER_DESCRIPTORS,
	type LanguageServerDescriptor,
	PYTHON_DESCRIPTOR,
	TYPESCRIPT_DESCRIPTOR,
} from "./domain/language-server-descriptor.ts";
export {
	type LineEdit,
	type LineEditFailure,
	type LineEditFailureReason,
	type LineEditInsertAfter,
	type LineEditInsertBefore,
	type LineEditOutcome,
	LineEditRace,
	LineEditRejected,
	type LineEditReplace,
	type LineEditRequest,
	lineEdit,
} from "./domain/line-edit.ts";
export type { LineHash } from "./domain/line-hash.ts";
export { lineHashOf } from "./domain/line-hash.ts";
export type { NpmPackageVersionMetadata, NpmRegistryBounds, NpmRegistryVersionRequest, NpmRepositoryMetadata } from "./domain/npm-package-metadata.ts";
export { outgoingCalls } from "./domain/outgoing-calls.ts";
export { prepareCallHierarchy } from "./domain/prepare-call-hierarchy.ts";
export { raceWorkspaceQuery } from "./domain/race-workspace-query.ts";
export { type RawRead, rawRead, WorkspaceEntryNotFound } from "./domain/raw-read.ts";
export {
	type FileMove,
	type ImportSpecifierOccurrence,
	type ImportSpecifierRewrite,
	planReferenceBasedRename,
	type ReferenceBasedRenameInput,
	type ReferenceBasedRenamePlan,
	type ReferencingFileInput,
} from "./domain/reference-based-rename.ts";
export type { ConciseProvenance, FormattedSymbol, FormattedSymbolSearchResult, ResponseFormat } from "./domain/response-format.ts";
export { formatProvenanced, formatSymbolSearchResult, toConciseProvenance } from "./domain/response-format.ts";
export type { SymbolDeclarationSnapshot } from "./domain/symbol-declaration-snapshot.ts";
export { assertBoundedSymbolQuery, InvalidSymbolQuery, MAX_SYMBOL_QUERY_BYTES } from "./domain/symbol-query.ts";
export {
	InvalidUnifiedDiff,
	parseUnifiedDiff,
	type UnifiedDiffHunk,
} from "./domain/unified-diff.ts";
export type { WorkspaceMapEntry, WorkspaceMapOptions, WorkspaceMapResult } from "./domain/workspace-map.ts";
export { computeWorkspaceMap } from "./domain/workspace-map.ts";
export type { WorkspaceQueryOutcome, WorkspaceQueryStatus } from "./domain/workspace-query-outcome.ts";
export type { SymbolSearchResult, WorkspaceLocation, WorkspaceSymbol } from "./domain/workspace-symbol.ts";
export { deriveExternalSearchCacheKey, type ExternalSearchCacheKey, type ExternalSearchSource } from "./external-search-cache/external-search-cache-key.ts";
export { InMemoryExternalSearchCache, type InMemoryExternalSearchCacheOptions } from "./external-search-cache/in-memory-external-search-cache.ts";
export type { ExternalSearchCachePort } from "./external-search-cache/port.ts";
export type { FileChangeEvent } from "./file-watcher/file-change-event.ts";
export { NodeFsFileWatcher } from "./file-watcher/node-fs-file-watcher.ts";
export type { FileWatcherPort } from "./file-watcher/port.ts";
export { WatchLimitExceeded, type WatchRegistration, WatchRegistry } from "./file-watcher/watch-registry.ts";
export type { GitDiffResult } from "./git/diff-result.ts";
export { LocalGit } from "./git/local-git.ts";
export type { GitLogEntry } from "./git/log-entry.ts";
export type { GitPort } from "./git/port.ts";
export type { GitStatusEntry, GitStatusSummary } from "./git/status.ts";
export {
	DEFAULT_GITHUB_API_BASE_URL,
	GithubSearchClient,
	type GithubSearchClientOptions,
	GithubSearchRateLimited,
	GithubSearchRequestFailed,
	GithubSearchResponseLimitExceeded,
	InvalidGithubSearchRequest,
} from "./github-search/github-search-client.ts";
export type { GithubSearchPort } from "./github-search/port.ts";
export type {
	AmbiguousInstalledPackageVersion,
	InstalledPackageEvidence,
	InstalledPackageVersionBounds,
	InstalledPackageVersionCandidate,
	InstalledPackageVersionOutcome,
	InstalledPackageVersionRequest,
	JavaScriptPackageManager,
	OversizedInstalledPackageVersion,
	ResolvedInstalledPackageVersion,
	UnavailableInstalledPackageVersion,
} from "./installed-package-version-resolver/installed-package-version.ts";
export { InvalidInstalledPackageVersionRequest, NpmLockfileVersionResolver } from "./installed-package-version-resolver/npm-lockfile-version-resolver.ts";
export type { InstalledPackageVersionResolverPort } from "./installed-package-version-resolver/port.ts";
export { type BufferPosition, LiveBuffer } from "./live-buffer/live-buffer.ts";
export { type HighlightSpan, highlightSpans } from "./live-buffer/syntax-highlight.ts";
export { type CanRevertMutationInputs, canRevertMutation, type MutationHistoryEntry, type MutationOperation } from "./mutation-history/mutation-history.ts";
export type { MutationHistoryPort, RecordMutationInput } from "./mutation-history/port.ts";
export { NpmPackageSourceResolver, type NpmPackageSourceResolverOptions } from "./npm-registry/npm-package-source-resolver.ts";
export {
	DEFAULT_NPM_REGISTRY,
	InvalidNpmRegistryRequest,
	NpmPackageNotFound,
	NpmRegistryAuthenticationRequired,
	NpmRegistryClient,
	type NpmRegistryClientOptions,
	NpmRegistryRequestFailed,
	NpmRegistryResponseLimitExceeded,
	NpmVersionNotFound,
} from "./npm-registry/npm-registry-client.ts";
export type { NpmRegistryPort } from "./npm-registry/port.ts";
export type { PackageSourceIndexPort } from "./package-source/index-port.ts";
export type {
	AmbiguousPackageSource,
	MismatchedPackageSource,
	OversizedPackageSource,
	PackageCoordinateRequest,
	PackageEcosystem,
	PackageRepositoryIdentity,
	PackageSourceBounds,
	PackageSourceCandidate,
	PackageSourceOperationResult,
	PackageSourceOutcome,
	PackageSourceRequest,
	PackageSourceVerification,
	PackageSourceVerificationMethod,
	PackageSourceWorkspace,
	ResolvedPackageCoordinate,
	UnauthenticatedPackageSource,
	UnavailablePackageSource,
	VerifiedPackageSource,
} from "./package-source/package-source.ts";
export { DEFAULT_PACKAGE_SOURCE_BOUNDS, PACKAGE_ECOSYSTEMS } from "./package-source/package-source.ts";
export type {
	PackageSourceIndexEntry,
	PackageSourceIndexKey,
	PackageSourceIndexPage,
	PackageSourceIndexQuery,
	PackageSourceListEntry,
} from "./package-source/package-source-index.ts";
export { queryPackageSourceIndex } from "./package-source/package-source-index.ts";
export { InvalidPackageSourceContract, resolvePackageSource } from "./package-source/resolve-package-source.ts";
export type { PackageSourceResolverPort } from "./package-source/resolver-port.ts";
export type { CodeIntelligencePort } from "./ports/code-intelligence-port.ts";
export type { SymbolIndexPort } from "./ports/symbol-index-port.ts";
export type { MissingWorkspaceEntry, PresentWorkspaceEntry, WorkspaceEntry, WorkspacePort } from "./ports/workspace-port.ts";
export type { CachedRepositoryEntry, CachedRepositoryPage, CachedRepositoryQuery, RepoCacheListEntry } from "./repo-fetcher/cached-repository-entry.ts";
export { GitRepoFetcher, type GitRepoFetcherOptions } from "./repo-fetcher/git-repo-fetcher.ts";
export type { RepoFetcherPort } from "./repo-fetcher/port.ts";
export {
	RepoFetchCapacityExceeded,
	RepoFetchFailed,
	RepoFetchLimitExceeded,
	type RepoFetchPolicy,
	type RepoFetchResult,
} from "./repo-fetcher/repo-fetch-result.ts";
export type { RepoReference } from "./repo-fetcher/repo-reference.ts";
export { InMemorySearchCache, type InMemorySearchCacheOptions } from "./search-cache/in-memory-search-cache.ts";
export type { SearchCachePort } from "./search-cache/port.ts";
export { deriveSearchCacheKey, type SearchCacheKey } from "./search-cache/search-cache-key.ts";
export { SqliteSearchCache, type SqliteSearchCacheOptions } from "./search-cache/sqlite-search-cache.ts";
export { TieredSearchCache } from "./search-cache/tiered-search-cache.ts";
export {
	AnnotationContainmentCycle,
	AnnotationRequiresAnchors,
	type ClosableSymbolIndex,
	CodeIntelligenceUnavailable,
	createLectorService,
	InvalidJobInput,
	InvalidWorkspaceRoot,
	JobWaitTooLong,
	type LectorService,
	type LectorServiceOptions,
	MutationEntryNotFound,
	MutationRevertStale,
	NotAGitRepository,
	OPERATION_NAMES,
	type OperationInputs,
	type OperationName,
	type OperationOutputs,
	PackageSourceResolverNotConfigured,
	ReferenceBasedRenameRequiresFreshGraph,
	RepoFetcherNotConfigured,
	SymbolComparisonUnsupportedLanguage,
	SymbolQueryUnavailable,
	UnknownAnnotationAnchor,
	UnknownAnnotationForContainment,
	UnknownWorkspace,
	UnsupportedJobOperation,
	WorkspaceChangedDuringPopulation,
	type WorkspaceId,
} from "./service.ts";
export type { SourcegraphSearchPort } from "./sourcegraph-search/port.ts";
export {
	DEFAULT_SOURCEGRAPH_BASE_URL,
	InvalidSourcegraphSearchRequest,
	SourcegraphSearchClient,
	type SourcegraphSearchClientOptions,
	SourcegraphSearchRequestFailed,
	SourcegraphSearchResponseLimitExceeded,
} from "./sourcegraph-search/sourcegraph-search-client.ts";
export { annotationsContainedFrom, type ContainmentReader, wouldCreateContainmentCycle } from "./symbol-annotation/annotation-containment.ts";
export { checkAnnotationStaleness } from "./symbol-annotation/check-annotation-staleness.ts";
export { InMemorySymbolAnnotations } from "./symbol-annotation/in-memory-symbol-annotations.ts";
export type { SymbolAnnotationListOptions, SymbolAnnotationPort } from "./symbol-annotation/port.ts";
export { SqliteSymbolAnnotations } from "./symbol-annotation/sqlite-symbol-annotations.ts";
export type {
	AnnotationId,
	AnnotationStatus,
	CreateSymbolAnnotationInput,
	SymbolAnnotation,
	SymbolAnnotationAnchor,
} from "./symbol-annotation/symbol-annotation.ts";
export { type AnchorReality, isAnnotationStale } from "./symbol-annotation/symbol-annotation-staleness.ts";
export { InMemorySymbolGraph } from "./symbol-graph/in-memory-symbol-graph.ts";
export { type PopulateSymbolGraphResult, populateSymbolGraph, type SymbolGraphPopulationFailure } from "./symbol-graph/populate-symbol-graph.ts";
export type { SymbolEdgeKind, SymbolEdgeRecord, SymbolGraphPort, SymbolNode } from "./symbol-graph/port.ts";
export { reachableSymbolsFrom } from "./symbol-graph/reachable-symbols-from.ts";
export { SqliteSymbolGraph } from "./symbol-graph/sqlite-symbol-graph.ts";
export { symbolEdgesFrom } from "./symbol-graph/symbol-edges-from.ts";
export { symbolEdgesTo } from "./symbol-graph/symbol-edges-to.ts";
export type { SymbolGraphGeneration, WorkspaceCacheStatus } from "./symbol-graph/symbol-graph-generation.ts";
export { deriveSymbolNodeId, type SymbolNodeId } from "./symbol-graph/symbol-node-id.ts";
export { findFiles } from "./text-search/find-files.ts";
export type { FindFilesResult } from "./text-search/find-files-result.ts";
export type { FindFilesOptions, TextSearchOptions, TextSearchPort } from "./text-search/port.ts";
export { RipgrepTextSearch } from "./text-search/ripgrep-text-search.ts";
export { searchText } from "./text-search/search-text.ts";
export type { TextSearchMatch, TextSearchResult } from "./text-search/text-search-result.ts";
export { lectorVersion } from "./version.ts";
