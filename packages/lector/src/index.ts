export {
	type ConnectLectorClientOptions,
	connectLectorClient,
	connectLectorClientAt,
	type LectorClient,
	remoteErrorIs,
	resolveLectorDaemonConnection,
} from "./client.ts";
export type { SymbolComparisonStatus, SymbolDeclarationComparison } from "./code-intelligence/compare-symbol-declarations.ts";
export type { Diagnostic, DiagnosticSeverity } from "./code-intelligence/diagnostic.ts";
export { diagnostics } from "./code-intelligence/diagnostics.ts";
export type { DocumentSymbolEntry } from "./code-intelligence/document-symbol.ts";
export { documentSymbols } from "./code-intelligence/document-symbols.ts";
export { type ClosableIntelligenceIndex, FallbackCodeIntelligenceIndex } from "./code-intelligence/fallback-code-intelligence-index.ts";
export { findReferences } from "./code-intelligence/find-references.ts";
export { goToDefinition } from "./code-intelligence/go-to-definition.ts";
export { goToImplementation } from "./code-intelligence/go-to-implementation.ts";
export type { Hover } from "./code-intelligence/hover.ts";
export { hoverAt } from "./code-intelligence/hover-at.ts";
export type {
	IntelligenceFidelity,
	IntelligenceProvenance,
	IntelligenceSourceOutcome,
	ProvenancedResult,
	SymbolSearchBounds,
} from "./code-intelligence/intelligence-provenance.ts";
export {
	descriptorForExtension,
	LANGUAGE_SERVER_DESCRIPTORS,
	type LanguageServerDescriptor,
	PYTHON_DESCRIPTOR,
	TYPESCRIPT_DESCRIPTOR,
} from "./code-intelligence/language-server-descriptor.ts";
export {
	LanguageServerCapacityExceeded,
	LanguageServerProcess,
	LanguageServerProcessExited,
	LanguageServerRequestTimedOut,
} from "./code-intelligence/lsp/language-server-process.ts";
export {
	LanguageFileLimitExceeded,
	LanguageFileOutsideWorkspace,
	LanguageServerPositionEncodingUnsupported,
	LanguageServerWorkspaceNotReady,
	LspSymbolIndex,
	type LspSymbolIndexOptions,
} from "./code-intelligence/lsp/lsp-symbol-index.ts";
export { PolyglotCodeIntelligenceIndex, type PolyglotIndexEntry } from "./code-intelligence/polyglot-code-intelligence-index.ts";
export type { CodeIntelligencePort } from "./code-intelligence/port.ts";
export type { SymbolDeclarationSnapshot } from "./code-intelligence/symbol-declaration-snapshot.ts";
export type { SymbolIndexPort } from "./code-intelligence/symbol-index-port.ts";
export { assertBoundedSymbolQuery, InvalidSymbolQuery, MAX_SYMBOL_QUERY_BYTES } from "./code-intelligence/symbol-query.ts";
export { TreeSitterSymbolIndex, type TreeSitterSymbolIndexOptions } from "./code-intelligence/tree-sitter/typescript-tree-sitter-symbol-index.ts";
export { TypeScriptCompilerSymbolIndex, type TypeScriptCompilerSymbolIndexOptions } from "./code-intelligence/typescript-compiler-symbol-index.ts";
export {
	BoundedJobExecutor,
	type BoundedJobExecutorOptions,
	JobCapacityExceeded,
	JobExecutorClosed,
	JobNotFound,
	type JobPriority,
	type JobSnapshot,
} from "./concurrency/bounded-job-executor.ts";
export { resolveLectorPaths } from "./constants.ts";
export { InMemoryContentCache } from "./content-cache/in-memory-content-cache.ts";
export type { ContentCacheEntry, ContentCachePort, ContentSymbol } from "./content-cache/port.ts";
export { SqliteContentCache } from "./content-cache/sqlite-content-cache.ts";
export { type ContentHash, contentHashOf } from "./content-identity/content-hash.ts";
export type { LineHash } from "./content-identity/line-hash.ts";
export { lineHashOf } from "./content-identity/line-hash.ts";
export { buildLectorApp, type LectorDaemonOptions, serveMain, startLectorDaemon } from "./daemon.ts";
export type {
	ExternalSearchBounds,
	GithubRepoCandidate,
	GithubRepoSearchResult,
	NpmPackageCandidate,
	SourcegraphCodeCandidate,
	SourcegraphLineMatch,
} from "./external-search/external-search-result.ts";
export { DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS, splitSourcegraphRepository } from "./external-search/external-search-result.ts";
export { deriveExternalSearchCacheKey, type ExternalSearchCacheKey, type ExternalSearchSource } from "./external-search-cache/external-search-cache-key.ts";
export { InMemoryExternalSearchCache, type InMemoryExternalSearchCacheOptions } from "./external-search-cache/in-memory-external-search-cache.ts";
export type { ExternalSearchCachePort } from "./external-search-cache/port.ts";
export type { FileChangeEvent } from "./file-watcher/file-change-event.ts";
export { NodeFsFileWatcher } from "./file-watcher/node-fs-file-watcher.ts";
export type { FileWatcherPort } from "./file-watcher/port.ts";
export { WatchLimitExceeded, type WatchRegistration, WatchRegistry } from "./file-watcher/watch-registry.ts";
export { assertSafeGitArgument, UnsafeGitArgument } from "./git/assert-safe-git-argument.ts";
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
export { GuardedLiveBuffer, type LiveBufferIdentity, type StaleBufferState } from "./live-buffer/guarded-live-buffer.ts";
export { type BufferPosition, LiveBuffer } from "./live-buffer/live-buffer.ts";
export { type HighlightSpan, highlightSpans } from "./live-buffer/syntax-highlight.ts";
export { detectLibc } from "./lsp-provisioning/detect-libc.ts";
export {
	DEFAULT_GITHUB_API_BASE_URL as LSP_PROVISIONING_DEFAULT_GITHUB_API_BASE_URL,
	GithubReleaseAssetUnavailable,
	type GithubReleaseInstallerOptions,
	GithubReleaseNotFound,
	GithubReleaseRequestFailed,
	resolveGithubReleaseInstall,
	UnsupportedReleaseArchiveFormat,
} from "./lsp-provisioning/github-release-installer.ts";
export { InstallConcurrencyLimiter } from "./lsp-provisioning/install-concurrency-limiter.ts";
export { InstallLocation } from "./lsp-provisioning/install-location.ts";
export { type InstallReceipt, parseInstallReceipt, receiptPurl, serializeInstallReceipt } from "./lsp-provisioning/install-receipt.ts";
export type {
	GithubReleaseLanguageServerSource,
	LanguageServerPackageSpec,
	LanguageServerSource,
	NpmLanguageServerSource,
} from "./lsp-provisioning/language-server-package-spec.ts";
export {
	LanguageServerProvisioner,
	type LanguageServerProvisionerOptions,
} from "./lsp-provisioning/language-server-provisioner.ts";
export type { LibcVariant, LspArchitecture, LspOperatingSystem, LspPlatform } from "./lsp-provisioning/lsp-platform.ts";
export { resolveLspPlatform, UnsupportedLspPlatform } from "./lsp-provisioning/lsp-platform.ts";
export { type NpmInstallerOptions, NpmInstallFailed, NpmInstallTimedOut, resolveNpmInstall } from "./lsp-provisioning/npm-installer.ts";
export type { LanguageServerProvisionerPort } from "./lsp-provisioning/port.ts";
export type { ProvisionOutcome } from "./lsp-provisioning/provision-outcome.ts";
export { tryReadReceipt, writeReceipt } from "./lsp-provisioning/receipt-store.ts";
export { resolveLspProvisioningRoot } from "./lsp-provisioning/resolve-lsp-provisioning-root.ts";
export type { ResolvedInstall } from "./lsp-provisioning/resolved-install.ts";
export { runStagedInstall, type StagedInstallInput, type StagedInstallResult } from "./lsp-provisioning/staged-install.ts";
export { type CanRevertMutationInputs, canRevertMutation, type MutationHistoryEntry, type MutationOperation } from "./mutation-history/mutation-history.ts";
export type { MutationHistoryPort, RecordMutationInput } from "./mutation-history/port.ts";
export type { NpmPackageVersionMetadata, NpmRegistryBounds, NpmRegistryVersionRequest, NpmRepositoryMetadata } from "./npm-registry/npm-package-metadata.ts";
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
export { assertSafePathSegment, UnsafePathSegment } from "./path-safety/assert-safe-path-segment.ts";
export { applyReferenceBasedRename, type ReferenceBasedRenameOutcome } from "./reference-based-rename/apply-reference-based-rename.ts";
export {
	type FileMove,
	type ImportSpecifierOccurrence,
	type ImportSpecifierRewrite,
	planReferenceBasedRename,
	type ReferenceBasedRenameInput,
	type ReferenceBasedRenamePlan,
	type ReferencingFileInput,
} from "./reference-based-rename/reference-based-rename.ts";
export { assertSafeRepoReference } from "./repo-fetcher/assert-safe-repo-reference.ts";
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
export type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "./symbol-graph/call-hierarchy.ts";
export { InMemorySymbolGraph } from "./symbol-graph/in-memory-symbol-graph.ts";
export { incomingCalls } from "./symbol-graph/incoming-calls.ts";
export { outgoingCalls } from "./symbol-graph/outgoing-calls.ts";
export { type PopulateSymbolGraphResult, populateSymbolGraph, type SymbolGraphPopulationFailure } from "./symbol-graph/populate-symbol-graph.ts";
export type { SymbolEdgeKind, SymbolEdgeRecord, SymbolGraphPort, SymbolNode } from "./symbol-graph/port.ts";
export { prepareCallHierarchy } from "./symbol-graph/prepare-call-hierarchy.ts";
export { reachableSymbolsFrom } from "./symbol-graph/reachable-symbols-from.ts";
export { SqliteSymbolGraph } from "./symbol-graph/sqlite-symbol-graph.ts";
export { symbolEdgesFrom } from "./symbol-graph/symbol-edges-from.ts";
export { symbolEdgesTo } from "./symbol-graph/symbol-edges-to.ts";
export type { SymbolGraphGeneration, WorkspaceCacheStatus } from "./symbol-graph/symbol-graph-generation.ts";
export { deriveSymbolNodeId, type SymbolNodeId } from "./symbol-graph/symbol-node-id.ts";
export { assertSafeGlobPattern, UnsafeGlobPattern } from "./text-search/assert-safe-glob-pattern.ts";
export { assertSafeSearchQuery, UnsafeSearchQuery } from "./text-search/assert-safe-search-query.ts";
export { findFiles } from "./text-search/find-files.ts";
export type { FindFilesResult } from "./text-search/find-files-result.ts";
export type { FindFilesOptions, TextSearchOptions, TextSearchPort } from "./text-search/port.ts";
export { RipgrepTextSearch } from "./text-search/ripgrep-text-search.ts";
export { searchText } from "./text-search/search-text.ts";
export type { TextSearchMatch, TextSearchResult } from "./text-search/text-search-result.ts";
export { lectorVersion } from "./version.ts";
export {
	type ApplyPatchRequest,
	applyPatch,
	PatchRejected,
} from "./workspace/apply-patch.ts";
export type { CodeRange } from "./workspace/code-range.ts";
export {
	type EditOutcome,
	type ExpectedHashEdit,
	exactEdit,
	StaleExpectedHash,
} from "./workspace/exact-edit.ts";
export type { FileTreeEntry, FileTreeEntryKind, FileTreePort } from "./workspace/file-tree-port.ts";
export { WorkspaceEntryAlreadyExists, WorkspaceEntryDoesNotExist } from "./workspace/file-tree-port.ts";
export { findWorkspaceSymbols } from "./workspace/find-workspace-symbols.ts";
export { InMemoryWorkspace } from "./workspace/in-memory-workspace.ts";
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
} from "./workspace/line-edit.ts";
export type { DirectoryListing } from "./workspace/list-directory.ts";
export { listDirectory } from "./workspace/list-directory.ts";
export { LocalFilesystemWorkspace, PathEscapesWorkspaceRoot } from "./workspace/local-filesystem-workspace.ts";
export type { MissingWorkspaceEntry, PresentWorkspaceEntry, WorkspaceEntry, WorkspacePort } from "./workspace/port.ts";
export { raceWorkspaceQuery } from "./workspace/race-workspace-query.ts";
export { type RawRead, rawRead, WorkspaceEntryNotFound } from "./workspace/raw-read.ts";
export { ReadOnlyWorkspace, WorkspaceIsReadOnly } from "./workspace/read-only-workspace.ts";
export type { ConciseProvenance, FormattedSymbol, FormattedSymbolSearchResult, ResponseFormat } from "./workspace/response-format.ts";
export { formatProvenanced, formatSymbolSearchResult, toConciseProvenance } from "./workspace/response-format.ts";
export { deriveSourceManifest, type SourceManifest, SourceManifestLimitExceeded } from "./workspace/source-manifest.ts";
export {
	InvalidUnifiedDiff,
	parseUnifiedDiff,
	type UnifiedDiffHunk,
} from "./workspace/unified-diff.ts";
export type { WorkspaceMapEntry, WorkspaceMapOptions, WorkspaceMapResult } from "./workspace/workspace-map.ts";
export { computeWorkspaceMap } from "./workspace/workspace-map.ts";
export type { WorkspaceQueryOutcome, WorkspaceQueryStatus } from "./workspace/workspace-query-outcome.ts";
export type { SymbolSearchResult, WorkspaceLocation, WorkspaceSymbol } from "./workspace/workspace-symbol.ts";
