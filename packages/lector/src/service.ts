import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Logger } from "@danypops/vehicle-server/logging";
import picomatch from "picomatch";
import { FallbackCodeIntelligenceIndex } from "./adapters/fallback-code-intelligence-index.ts";
import { LocalFilesystemWorkspace } from "./adapters/local-filesystem-workspace.ts";
import { discoverWorkspaceDescriptors } from "./adapters/lsp/discover-seed-file.ts";
import { LspSymbolIndex } from "./adapters/lsp/lsp-symbol-index.ts";
import { deriveSourceManifest } from "./adapters/source-manifest.ts";
import { findImportSpecifiers } from "./adapters/tree-sitter/import-specifiers.ts";
import { TreeSitterSymbolIndex } from "./adapters/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { TypeScriptCompilerSymbolIndex } from "./adapters/typescript-compiler-symbol-index.ts";
import { InMemoryContentCache } from "./content-cache/in-memory-content-cache.ts";
import type { ContentCachePort } from "./content-cache/port.ts";
import { applyPatch, PatchRejected } from "./domain/apply-patch.ts";
import { applyReferenceBasedRename, type ReferenceBasedRenameOutcome } from "./domain/apply-reference-based-rename.ts";
import { applyWorkspaceEdit, collectTouchedPaths } from "./domain/apply-workspace-edit.ts";
import { assertAbsolutePath, RelativeWorkspacePath } from "./domain/assert-absolute-path.ts";
import { BoundedJobExecutor, type JobSnapshot } from "./domain/bounded-job-executor.ts";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "./domain/call-hierarchy.ts";
import type { SymbolComparisonStatus } from "./domain/compare-symbol-declarations.ts";
import { type ContentHash, contentHashOf } from "./domain/content-hash.ts";
import type { Diagnostic } from "./domain/diagnostic.ts";
import { diagnostics as diagnosticsQuery } from "./domain/diagnostics.ts";
import type { DocumentSymbolEntry } from "./domain/document-symbol.ts";
import { documentSymbols as documentSymbolsQuery } from "./domain/document-symbols.ts";
import { type EditOutcome, type ExpectedHashEdit, exactEdit, StaleExpectedHash } from "./domain/exact-edit.ts";
import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeCandidate } from "./domain/external-search-result.ts";
import { findReferences as findReferencesQuery } from "./domain/find-references.ts";
import { findWorkspaceSymbols } from "./domain/find-workspace-symbols.ts";
import { goToDefinition as goToDefinitionQuery } from "./domain/go-to-definition.ts";
import { goToImplementation as goToImplementationQuery } from "./domain/go-to-implementation.ts";
import type { Hover } from "./domain/hover.ts";
import { hoverAt } from "./domain/hover-at.ts";
import { incomingCalls as incomingCallsQuery } from "./domain/incoming-calls.ts";
import type { IntelligenceProvenance } from "./domain/intelligence-provenance.ts";
import { LANGUAGE_SERVER_DESCRIPTORS, type LanguageServerDescriptor } from "./domain/language-server-descriptor.ts";
import { type LineEdit, type LineEditOutcome, LineEditRace, LineEditRejected, lineEdit } from "./domain/line-edit.ts";
import { type DirectoryListing, listDirectory } from "./domain/list-directory.ts";
import { outgoingCalls as outgoingCallsQuery } from "./domain/outgoing-calls.ts";
import { prepareCallHierarchy as prepareCallHierarchyQuery } from "./domain/prepare-call-hierarchy.ts";
import { type RawRead, rawRead, WorkspaceEntryNotFound } from "./domain/raw-read.ts";
import { planReferenceBasedRename } from "./domain/reference-based-rename.ts";
import { formatProvenanced, formatSymbolSearchResult, type ResponseFormat } from "./domain/response-format.ts";
import { SerialExecutionQueue } from "./domain/serial-execution-queue.ts";
import { assertBoundedSymbolQuery } from "./domain/symbol-query.ts";
import type { ParsedWorkspaceEdit, RenameRange } from "./domain/workspace-edit.ts";
import { computeWorkspaceMap, type WorkspaceMapResult } from "./domain/workspace-map.ts";
import type { WorkspaceQueryOutcome } from "./domain/workspace-query-outcome.ts";
import type { SymbolSearchResult, WorkspaceLocation } from "./domain/workspace-symbol.ts";
import { InMemoryExternalSearchCache } from "./external-search-cache/in-memory-external-search-cache.ts";
import type { ExternalSearchCachePort } from "./external-search-cache/port.ts";
import type { FileChangeEvent } from "./file-watcher/file-change-event.ts";
import { NodeFsFileWatcher } from "./file-watcher/node-fs-file-watcher.ts";
import type { FileWatcherPort } from "./file-watcher/port.ts";
import { WatchLimitExceeded, WatchRegistry } from "./file-watcher/watch-registry.ts";
import type { GitDiffResult } from "./git/diff-result.ts";
import { LocalGit } from "./git/local-git.ts";
import type { GitLogEntry } from "./git/log-entry.ts";
import type { GitPort } from "./git/port.ts";
import type { GitStatusSummary } from "./git/status.ts";
import { GithubSearchClient } from "./github-search/github-search-client.ts";
import type { GithubSearchPort } from "./github-search/port.ts";
import { NpmLockfileVersionResolver } from "./installed-package-version-resolver/npm-lockfile-version-resolver.ts";
import type { LanguageServerProvisionerPort } from "./lsp-provisioning/port.ts";
import type { MutationHistoryEntry } from "./mutation-history/mutation-history.ts";
import type { MutationHistoryPort } from "./mutation-history/port.ts";
import { NpmPackageSourceResolver } from "./npm-registry/npm-package-source-resolver.ts";
import { NpmRegistryClient } from "./npm-registry/npm-registry-client.ts";
import type { NpmRegistryPort } from "./npm-registry/port.ts";
import { InMemoryPackageSourceIndex } from "./package-source/in-memory-package-source-index.ts";
import type { PackageSourceIndexPort } from "./package-source/index-port.ts";
import type { PackageEcosystem, PackageSourceBounds, PackageSourceOperationResult, PackageSourceRequest } from "./package-source/package-source.ts";
import type { PackageSourceIndexQuery, PackageSourceListEntry } from "./package-source/package-source-index.ts";
import type { PackageSourceResolverPort } from "./package-source/resolver-port.ts";
import type { CodeIntelligencePort } from "./ports/code-intelligence-port.ts";
import type { FileTreePort } from "./ports/file-tree-port.ts";
import type { SymbolIndexPort } from "./ports/symbol-index-port.ts";
import type { WorkspacePort } from "./ports/workspace-port.ts";
import type { CachedRepositoryPage, CachedRepositoryQuery } from "./repo-fetcher/cached-repository-entry.ts";
import { isCacheFreshByGit } from "./repo-fetcher/git-cache-freshness.ts";
import type { RepoFetcherPort } from "./repo-fetcher/port.ts";
import { shouldRefetchFromRemote } from "./repo-fetcher/remote-cache-freshness.ts";
import type { RepoFetchResult } from "./repo-fetcher/repo-fetch-result.ts";
import type { RepoReference } from "./repo-fetcher/repo-reference.ts";
import { InMemorySearchCache } from "./search-cache/in-memory-search-cache.ts";
import type { SearchCachePort } from "./search-cache/port.ts";
import { createCrossWorkspaceHandlers } from "./service/cross-workspace-handlers.ts";
import { createExternalSearchHandlers } from "./service/external-search-handlers.ts";
import { createGitHandlers } from "./service/git-handlers.ts";
import { GraphRefreshCoordinator } from "./service/graph-refresh-coordinator.ts";
import { MutationHistoryCoordinator } from "./service/mutation-history-handlers.ts";
import { createPackageSourceHandlers } from "./service/package-source-handlers.ts";
import { createRepoFetchHandlers } from "./service/repo-fetch-handlers.ts";
import { type ClosableSymbolIndex, supportsCodeIntelligence, WarmIndexRegistry } from "./service/warm-index-registry.ts";
import type { SourcegraphSearchPort } from "./sourcegraph-search/port.ts";
import { SourcegraphSearchClient } from "./sourcegraph-search/sourcegraph-search-client.ts";
import { annotationsContainedFrom, wouldCreateContainmentCycle } from "./symbol-annotation/annotation-containment.ts";
import { checkAnnotationStaleness } from "./symbol-annotation/check-annotation-staleness.ts";
import { InMemorySymbolAnnotations } from "./symbol-annotation/in-memory-symbol-annotations.ts";
import type { SymbolAnnotationListOptions, SymbolAnnotationPort } from "./symbol-annotation/port.ts";
import type { AnnotationId, SymbolAnnotation, SymbolAnnotationAnchor } from "./symbol-annotation/symbol-annotation.ts";
import { InMemorySymbolGraph } from "./symbol-graph/in-memory-symbol-graph.ts";
import { type PopulateSymbolGraphResult, populateSymbolGraph as populateSymbolGraphQuery } from "./symbol-graph/populate-symbol-graph.ts";
import type { SymbolEdgeKind, SymbolGraphPort, SymbolNode } from "./symbol-graph/port.ts";
import { purgeFilesNoLongerWalked } from "./symbol-graph/purge-stale-graph-entries.ts";
import { reachableSymbolsFrom } from "./symbol-graph/reachable-symbols-from.ts";
import { symbolEdgesFrom } from "./symbol-graph/symbol-edges-from.ts";
import { symbolEdgesTo } from "./symbol-graph/symbol-edges-to.ts";
import type { SymbolGraphGeneration, WorkspaceCacheStatus } from "./symbol-graph/symbol-graph-generation.ts";
import { deriveSymbolNodeId } from "./symbol-graph/symbol-node-id.ts";
import { findFiles as findFilesQuery } from "./text-search/find-files.ts";
import type { FindFilesResult } from "./text-search/find-files-result.ts";
import type { TextSearchPort } from "./text-search/port.ts";
import { RipgrepTextSearch } from "./text-search/ripgrep-text-search.ts";
import { searchText as searchTextQuery } from "./text-search/search-text.ts";
import type { TextSearchResult } from "./text-search/text-search-result.ts";

/**
 * Identifies which registered workspace an operation targets. There is no
 * default/implicit workspace: an operation must always name one explicitly.
 * (Locus LCS-BUG-97/LCS-BUG-88 class -- an operation given no explicit
 * target must never fall back to "whatever was registered/used last".)
 */
export type WorkspaceId = string;

/** Raised when an operation names a workspaceId nothing was registered under. */
export class UnknownWorkspace extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`no workspace registered under id "${workspaceId}"`);
		this.name = "UnknownWorkspace";
	}
}

/** Raised when workspace.registerPath is given a path that isn't a real, accessible directory. */
export class InvalidWorkspaceRoot extends Error {
	constructor(
		readonly path: string,
		reason: string,
	) {
		super(`cannot register "${path}" as a workspace root: ${reason}`);
		this.name = "InvalidWorkspaceRoot";
	}
}

/** Raised when a symbol query targets a workspace with no known root path (not registered via workspace.registerPath). */
export class SymbolQueryUnavailable extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}" has no known root path; symbol queries require a workspace registered via workspace.registerPath`);
		this.name = "SymbolQueryUnavailable";
	}
}

/** Raised when a git operation targets a workspace whose root is not inside a git repository -- a real, expected case, not every registered workspace is one. */
/** Raised when the negotiated backend has no rename/prepareRename support at all (e.g. a tree-sitter fallback, or a real server that never advertised renameProvider). */
export class RenameNotSupported extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}"'s symbol index does not support rename -- the negotiated backend never advertised renameProvider`);
		this.name = "RenameNotSupported";
	}
}

export class NotAGitRepository extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}" is not inside a git repository`);
		this.name = "NotAGitRepository";
	}
}

/**
 * Raised when workspace.compareSymbolAcrossVersions targets a file extension outside
 * Lector's tree-sitter TypeScript/JavaScript grammars -- a narrower list than
 * UnsupportedLanguage's LSP-backed extension set, since this operation's first pass is the
 * syntactic tier only (no real checkout, no project-aware LSP resolution across versions yet).
 */
export class SymbolComparisonUnsupportedLanguage extends Error {
	constructor(readonly extension: string) {
		super(`workspace.compareSymbolAcrossVersions has no tree-sitter grammar for extension "${extension}"`);
		this.name = "SymbolComparisonUnsupportedLanguage";
	}
}

/** Raised when a file's extension (or, with no path/seedFile at all, the whole workspace) matches none of Lector's known LanguageServerDescriptors. */
export class UnsupportedLanguage extends Error {
	constructor(readonly hint: string) {
		super(`no supported language server for "${hint}" -- known extensions: ${LANGUAGE_SERVER_DESCRIPTORS.flatMap((d) => d.extensions).join(", ")}`);
		this.name = "UnsupportedLanguage";
	}
}

/**
 * Raised when a Tier A code-intelligence operation (goToDefinition, findReferences,
 * hover, documentSymbols) targets a workspace whose warm index is not backed by a
 * real language server -- e.g. a test override using the tree-sitter backend, which
 * has no type system and cannot honestly resolve cross-file references or types.
 * An honest failure, not a silent empty result or a crash.
 */
export class CodeIntelligenceUnavailable extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(
			`workspace "${workspaceId}"'s symbol index does not support code-intelligence queries (definition/references/hover/documentSymbols/diagnostics/callHierarchy) -- only findSymbols`,
		);
		this.name = "CodeIntelligenceUnavailable";
	}
}

/** Raised when a proposed annotation anchor does not resolve to a real, currently-known symbol node (the graph has no record of it) or the anchor's file does not exist -- an annotation must anchor to symbols Lector actually knows about, never a position asserted on faith. */
export class UnknownAnnotationAnchor extends Error {
	constructor(
		readonly path: string,
		readonly line: number,
		readonly character: number,
	) {
		super(`no known symbol at ${path}:${line}:${character} -- populate the symbol graph first, or check the position`);
		this.name = "UnknownAnnotationAnchor";
	}
}

/** Raised when workspace.createAnnotation/refreshAnnotation is given zero anchors -- an annotation with nothing to invalidate it against is never allowed to exist. */
export class AnnotationRequiresAnchors extends Error {
	constructor() {
		super("an annotation requires at least one anchor");
		this.name = "AnnotationRequiresAnchors";
	}
}

/** Raised when workspace.containAnnotation names a parentId or childId that get() cannot find -- containment is a relation between two real annotations, never asserted on faith. */
export class UnknownAnnotationForContainment extends Error {
	constructor(readonly id: string) {
		super(`no annotation "${id}" -- containment requires both the parent and the child to already exist`);
		this.name = "UnknownAnnotationForContainment";
	}
}

/** Raised when workspace.containAnnotation would create a cycle (a self-loop, or the child can already reach the parent) -- rejected up front, never silently accepted. */
export class AnnotationContainmentCycle extends Error {
	constructor(
		readonly parentId: string,
		readonly childId: string,
	) {
		super(`making "${childId}" a child of "${parentId}" would create a containment cycle`);
		this.name = "AnnotationContainmentCycle";
	}
}

/** Raised when repo.fetch is called on a service constructed without a createRepoFetcher option -- fetching an external repo needs a real disk location a host must explicitly provide, unlike e.g. createSymbolGraph's safe in-memory default. */
export class RepoFetcherNotConfigured extends Error {
	constructor() {
		super("repo.fetch requires a service constructed with options.createRepoFetcher");
		this.name = "RepoFetcherNotConfigured";
	}
}

/** Raised by repo.evictCache when the target cache entry's resolved path is still a currently-registered workspace. There is no workspace.unregister operation, so evicting would delete a live workspace's backing storage out from under every other operation still reading it. */
export class RepoCacheEntryInUse extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`cannot evict: still registered as workspace "${workspaceId}"`);
		this.name = "RepoCacheEntryInUse";
	}
}

export class PackageSourceResolverNotConfigured extends Error {
	constructor() {
		super("package.resolveSource requires a service constructed with repository fetching");
		this.name = "PackageSourceResolverNotConfigured";
	}
}

/** Raised by package.removeSource/cleanSources when the entry's own recorded workspaceId is still a currently-registered workspace. There is no workspace.unregister operation, mirroring RepoCacheEntryInUse's identical limitation for repo.evictCache. */
export class PackageSourceEntryInUse extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`cannot remove: still registered as workspace "${workspaceId}"`);
		this.name = "PackageSourceEntryInUse";
	}
}

export class UnsupportedJobOperation extends Error {
	constructor(readonly operation: string) {
		super(`operation "${operation}" cannot run as a background job; supported operations: workspace.populateSymbolGraph`);
		this.name = "UnsupportedJobOperation";
	}
}

export class InvalidJobInput extends Error {
	constructor(reason: string) {
		super(`invalid background job input: ${reason}`);
		this.name = "InvalidJobInput";
	}
}

export class WorkspaceChangedDuringPopulation extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(
			`workspace "${workspaceId}" changed while its symbol graph was being populated; no cached generation was recorded -- retry against a stable source tree`,
		);
		this.name = "WorkspaceChangedDuringPopulation";
	}
}

/** A revert is only safe when the file's current content is exactly what the targeted mutation itself produced -- anything else (a later edit, a deletion) means reverting now would silently clobber a change this entry never knew about. Matches every other Lector write's own expected-hash-guard discipline. */
export class MutationEntryNotFound extends Error {
	constructor(readonly entryId: string) {
		super(`no mutation history entry "${entryId}" -- it was never recorded, already evicted (bounded history), or belongs to a different workspace`);
		this.name = "MutationEntryNotFound";
	}
}

export class MutationRevertStale extends Error {
	constructor(
		readonly entryId: string,
		readonly path: string,
	) {
		super(`"${path}" has changed since mutation "${entryId}" was applied -- refusing to revert over a change this entry never knew about`);
		this.name = "MutationRevertStale";
	}
}

/** A partial multi-file change scores worse than no change at all -- CodeScaleBench's own finding. Refuses to touch anything rather than rename against a symbol graph that doesn't honestly know every reference yet. */
export class ReferenceBasedRenameRequiresFreshGraph extends Error {
	constructor(
		readonly workspaceId: WorkspaceId,
		readonly status: string,
	) {
		super(
			`workspace "${workspaceId}"'s symbol graph is "${status}", not fully cached -- refusing to rename against an incomplete reference set; populate the graph first`,
		);
		this.name = "ReferenceBasedRenameRequiresFreshGraph";
	}
}

export type JobTopic = string & { readonly __brand: "JobTopic" };
export type JobWatchId = string & { readonly __brand: "JobWatchId" };

function jobTopicFor(jobId: string): JobTopic {
	// The only constructor for this topic namespace; callers cannot mix arbitrary push topics with job topics.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return `lector.job.${jobId}` as JobTopic;
}

function jobWatchIdFor(jobId: string): JobWatchId {
	// The only constructor for job-watch ids; a job id cannot be passed where a watch id is required.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return `job-watch:${jobId}` as JobWatchId;
}

export class JobWaitTooLong extends Error {
	constructor(
		readonly waitMs: number,
		readonly maxWaitMs: number,
	) {
		super(
			`background job initial wait ${waitMs}ms exceeds the ${maxWaitMs}ms service bound; submit with a shorter wait and follow completion through job.watch`,
		);
		this.name = "JobWaitTooLong";
	}
}

export type OperationName =
	| "workspace.rawRead"
	| "workspace.exactEdit"
	| "workspace.deleteEntry"
	| "workspace.lineEdit"
	| "workspace.applyPatch"
	| "workspace.mutationHistory"
	| "workspace.revertMutation"
	| "workspace.registerPath"
	| "workspace.findSymbols"
	| "workspace.goToDefinition"
	| "workspace.goToImplementation"
	| "workspace.findReferences"
	| "workspace.hover"
	| "workspace.documentSymbols"
	| "workspace.diagnostics"
	| "workspace.prepareCallHierarchy"
	| "workspace.incomingCalls"
	| "workspace.outgoingCalls"
	| "workspace.populateSymbolGraph"
	| "workspace.reachableFrom"
	| "workspace.symbolEdgesFrom"
	| "workspace.symbolEdgesTo"
	| "workspace.hasWarmIndex"
	| "workspace.cacheStatus"
	| "workspace.referenceBasedRename"
	| "workspace.prepareRename"
	| "workspace.rename"
	| "workspace.gitStatus"
	| "workspace.gitLog"
	| "workspace.gitDiff"
	| "workspace.compareSymbolAcrossVersions"
	| "repo.fetch"
	| "repo.listCache"
	| "repo.evictCache"
	| "package.resolveSource"
	| "package.listSources"
	| "package.removeSource"
	| "package.cleanSources"
	| "search.githubRepos"
	| "search.npmPackages"
	| "search.sourcegraphCode"
	| "workspace.searchText"
	| "workspace.findFiles"
	| "workspace.watch"
	| "workspace.unwatch"
	| "search.symbols"
	| "search.text"
	| "job.submit"
	| "job.status"
	| "job.watch"
	| "workspace.createAnnotation"
	| "workspace.getAnnotation"
	| "workspace.listAnnotations"
	| "workspace.refreshAnnotation"
	| "workspace.scrubAnnotation"
	| "workspace.restoreAnnotation"
	| "workspace.containAnnotation"
	| "workspace.uncontainAnnotation"
	| "workspace.annotationTree"
	| "workspace.map"
	| "workspace.listDirectory"
	| "workspace.createDirectory"
	| "workspace.renamePath"
	| "workspace.deleteDirectory";

export const OPERATION_NAMES: readonly OperationName[] = [
	"workspace.rawRead",
	"workspace.exactEdit",
	"workspace.deleteEntry",
	"workspace.lineEdit",
	"workspace.applyPatch",
	"workspace.mutationHistory",
	"workspace.revertMutation",
	"workspace.registerPath",
	"workspace.findSymbols",
	"workspace.goToDefinition",
	"workspace.goToImplementation",
	"workspace.findReferences",
	"workspace.hover",
	"workspace.documentSymbols",
	"workspace.diagnostics",
	"workspace.prepareCallHierarchy",
	"workspace.incomingCalls",
	"workspace.outgoingCalls",
	"workspace.populateSymbolGraph",
	"workspace.reachableFrom",
	"workspace.symbolEdgesFrom",
	"workspace.symbolEdgesTo",
	"workspace.hasWarmIndex",
	"workspace.cacheStatus",
	"workspace.referenceBasedRename",
	"workspace.prepareRename",
	"workspace.rename",
	"workspace.gitStatus",
	"workspace.gitLog",
	"workspace.gitDiff",
	"workspace.compareSymbolAcrossVersions",
	"repo.fetch",
	"repo.listCache",
	"repo.evictCache",
	"package.resolveSource",
	"package.listSources",
	"package.removeSource",
	"package.cleanSources",
	"search.githubRepos",
	"search.npmPackages",
	"search.sourcegraphCode",
	"workspace.searchText",
	"workspace.findFiles",
	"workspace.watch",
	"workspace.unwatch",
	"search.symbols",
	"search.text",
	"job.submit",
	"job.status",
	"job.watch",
	"workspace.createAnnotation",
	"workspace.getAnnotation",
	"workspace.listAnnotations",
	"workspace.refreshAnnotation",
	"workspace.scrubAnnotation",
	"workspace.restoreAnnotation",
	"workspace.containAnnotation",
	"workspace.uncontainAnnotation",
	"workspace.annotationTree",
	"workspace.map",
	"workspace.listDirectory",
	"workspace.createDirectory",
	"workspace.renamePath",
	"workspace.deleteDirectory",
];

/** A single position within a file already registered under `workspaceId`, 1-indexed. */
interface WorkspacePosition {
	workspaceId: WorkspaceId;
	path: string;
	line: number;
	character: number;
}

export interface OperationInputs {
	"workspace.rawRead": { workspaceId: WorkspaceId; path: string };
	"workspace.exactEdit": { workspaceId: WorkspaceId } & ExpectedHashEdit;
	"workspace.deleteEntry": { workspaceId: WorkspaceId; path: string; expectedHash: ContentHash };
	"workspace.lineEdit": { workspaceId: WorkspaceId; path: string; edits: readonly LineEdit[] };
	"workspace.applyPatch": { workspaceId: WorkspaceId; path: string; expectedHash: ContentHash; patchText: string };
	"workspace.mutationHistory": { workspaceId: WorkspaceId; path: string; maxResults: number };
	"workspace.revertMutation": { workspaceId: WorkspaceId; entryId: string };
	"workspace.registerPath": { path: string };
	"workspace.listDirectory": { workspaceId: WorkspaceId; path: string };
	"workspace.createDirectory": { workspaceId: WorkspaceId; path: string };
	"workspace.renamePath": { workspaceId: WorkspaceId; oldPath: string; newPath: string };
	"workspace.deleteDirectory": { workspaceId: WorkspaceId; path: string };
	"workspace.findSymbols": { workspaceId: WorkspaceId; query: string; seedFile?: string; maxResults?: number; responseFormat?: ResponseFormat };
	"workspace.goToDefinition": WorkspacePosition;
	"workspace.goToImplementation": WorkspacePosition;
	"workspace.findReferences": WorkspacePosition & { includeDeclaration: boolean; responseFormat?: ResponseFormat };
	"workspace.hover": WorkspacePosition;
	"workspace.documentSymbols": { workspaceId: WorkspaceId; path: string };
	"workspace.diagnostics": { workspaceId: WorkspaceId; path: string };
	"workspace.prepareCallHierarchy": WorkspacePosition;
	"workspace.incomingCalls": WorkspacePosition;
	"workspace.outgoingCalls": WorkspacePosition;
	"workspace.populateSymbolGraph": { workspaceId: WorkspaceId; maxFiles: number; maxSymbolsPerFile: number };
	"workspace.reachableFrom": WorkspacePosition & { maxDepth: number; kind?: SymbolEdgeKind };
	"workspace.symbolEdgesFrom": WorkspacePosition & { kind?: SymbolEdgeKind };
	"workspace.symbolEdgesTo": WorkspacePosition & { kind?: SymbolEdgeKind };
	"workspace.hasWarmIndex": { workspaceId: WorkspaceId; path?: string };
	"workspace.cacheStatus": { workspaceId: WorkspaceId; maxFiles: number; maxSymbolsPerFile: number };
	/** maxFiles/maxSymbolsPerFile gate the same freshness check cacheStatus uses -- this rename refuses outright unless the graph is fully "cached" (never "partial") for those exact bounds. */
	"workspace.referenceBasedRename": { workspaceId: WorkspaceId; fromPath: string; toPath: string; maxFiles: number; maxSymbolsPerFile: number };
	"workspace.prepareRename": WorkspacePosition;
	"workspace.rename": WorkspacePosition & { newName: string };
	"workspace.gitStatus": { workspaceId: WorkspaceId };
	"workspace.gitLog": { workspaceId: WorkspaceId; maxCount: number };
	"workspace.gitDiff": { workspaceId: WorkspaceId; ref?: string; maxBytes: number };
	/** toRef omitted means "the current working tree" -- fromRef is always a real git ref, never optional, since there is always at least one real version to compare from. */
	"workspace.compareSymbolAcrossVersions": { workspaceId: WorkspaceId; path: string; symbolName: string; fromRef: string; toRef?: string; maxBytes: number };
	"repo.fetch": RepoReference & { forceRefresh?: boolean };
	"repo.listCache": CachedRepositoryQuery & { maxResults: number; cursor?: string };
	"repo.evictCache": RepoReference;
	"package.resolveSource": { request: PackageSourceRequest; bounds: PackageSourceBounds };
	/** Every field optional -- an omitted ecosystem/text means "every recorded package source." */
	"package.listSources": PackageSourceIndexQuery & { maxResults: number; cursor?: string };
	"package.removeSource": { ecosystem: PackageEcosystem; registry: string | null; name: string; resolvedVersion: string };
	/** ecosystem omitted means every ecosystem. */
	"package.cleanSources": { ecosystem?: PackageEcosystem };
	/** Explicit-query search only, never open-ended discovery/trending -- results are shaped as direct repo.fetch inputs (host/owner/repo). */
	"search.githubRepos": { query: string; maxResults: number };
	/** Results are shaped as direct package.resolveSource inputs (name, plus the version already returned). */
	"search.npmPackages": { query: string; maxResults: number };
	/** Content search across public GitHub via sourcegraph.com -- a genuinely different discovery mode than the two above (which repos contain X, not which repos/packages match X by name/metadata). Each candidate's repository field feeds repo.fetch once split via splitSourcegraphRepository. */
	"search.sourcegraphCode": { query: string; maxResults: number };
	"workspace.searchText": { workspaceId: WorkspaceId; query: string; maxMatches: number; maxBytes: number };
	/** `patterns` are OR'd together -- a file matching any one of them is included. */
	"workspace.findFiles": { workspaceId: WorkspaceId; patterns: readonly string[]; maxResults: number; maxBytes: number };
	/** Registers a real, ongoing watch for files matching `pattern` under workspaceId, published to the returned topic via the daemon's PushChannel ("/push") going forward. */
	"workspace.watch": { workspaceId: WorkspaceId; pattern: string };
	"workspace.unwatch": { watchId: string };
	/**
	 * No single workspaceId -- fans out across several at once, unlike every other findSymbols-
	 * shaped operation. `workspaceIds`, when given, restricts the fan-out to exactly those
	 * (each validated -- an unknown id is reported per-entry, not silently dropped). Omitted
	 * defaults to every currently-registered workspace -- found live, not assumed: this daemon is
	 * a shared, system-wide service, so "every registered workspace" can include projects an
	 * entirely different, concurrent Pi session registered, not just this caller's own. A caller
	 * that means "my own current projects" must say so explicitly.
	 */
	"search.symbols": { query: string; workspaceIds?: readonly WorkspaceId[]; timeoutMs?: number };
	"search.text": { query: string; maxMatches: number; maxBytes: number; workspaceIds?: readonly WorkspaceId[]; timeoutMs?: number };
	"job.submit": {
		operation: "workspace.populateSymbolGraph";
		input: { workspaceId: WorkspaceId; maxFiles: number; maxSymbolsPerFile: number };
		/** Bounded wait before returning the current snapshot. Zero/omitted always returns immediately. */
		waitMs?: number;
	};
	"job.status": { jobId: string };
	"job.watch": { jobId: string };
	"workspace.createAnnotation": {
		workspaceId: WorkspaceId;
		subtype: string;
		title: string;
		body: string;
		/** Positions only -- symbolNodeId and the anchor's baseline file hash are derived server-side from the live graph/workspace, never trusted from the caller. */
		anchors: readonly { path: string; line: number; character: number }[];
	};
	"workspace.getAnnotation": { workspaceId: WorkspaceId; id: AnnotationId };
	"workspace.listAnnotations": { workspaceId: WorkspaceId; subtype?: string; status?: "fresh" | "stale" | "scrubbed"; maxResults?: number; query?: string };
	"workspace.refreshAnnotation": {
		workspaceId: WorkspaceId;
		id: AnnotationId;
		subtype: string;
		title: string;
		body: string;
		anchors: readonly { path: string; line: number; character: number }[];
	};
	"workspace.scrubAnnotation": { workspaceId: WorkspaceId; id: AnnotationId };
	"workspace.restoreAnnotation": { workspaceId: WorkspaceId; id: AnnotationId };
	"workspace.containAnnotation": { workspaceId: WorkspaceId; parentId: AnnotationId; childId: AnnotationId };
	"workspace.uncontainAnnotation": { workspaceId: WorkspaceId; parentId: AnnotationId; childId: AnnotationId };
	"workspace.annotationTree": { workspaceId: WorkspaceId; rootId: AnnotationId; maxDepth: number };
	"workspace.map": { workspaceId: WorkspaceId; maxNodes: number; maxEdges: number; maxEntries: number; maxBytes: number };
}

type Provenanced<T> = T & { readonly provenance: IntelligenceProvenance };

export interface OperationOutputs {
	"workspace.rawRead": RawRead;
	"workspace.exactEdit": EditOutcome;
	"workspace.deleteEntry": { path: string; previousHash: ContentHash | null };
	"workspace.lineEdit": LineEditOutcome;
	"workspace.applyPatch": EditOutcome;
	"workspace.mutationHistory": { entries: readonly MutationHistoryEntry[] };
	/** newHash is null when the reverted-to state is "the file doesn't exist" -- reverting a create back to nonexistence, or reverting a delete when the file has stayed deleted since. */
	"workspace.revertMutation": { path: string; newHash: ContentHash | null };
	"workspace.registerPath": { workspaceId: WorkspaceId; created: boolean };
	"workspace.listDirectory": DirectoryListing;
	"workspace.createDirectory": { path: string };
	"workspace.renamePath": { oldPath: string; newPath: string };
	"workspace.deleteDirectory": { path: string };
	"workspace.findSymbols": SymbolSearchResult;
	"workspace.goToDefinition": Provenanced<{ locations: readonly WorkspaceLocation[] }>;
	"workspace.goToImplementation": Provenanced<{ locations: readonly WorkspaceLocation[] }>;
	"workspace.findReferences": Provenanced<{ locations: readonly WorkspaceLocation[] }>;
	"workspace.hover": Provenanced<{ hover: Hover | undefined }>;
	"workspace.documentSymbols": Provenanced<{ symbols: readonly DocumentSymbolEntry[] }>;
	"workspace.diagnostics": Provenanced<{ diagnostics: readonly Diagnostic[] }>;
	"workspace.prepareCallHierarchy": Provenanced<{ items: readonly CallHierarchyEntry[] }>;
	"workspace.incomingCalls": Provenanced<{ calls: readonly IncomingCall[] }>;
	"workspace.outgoingCalls": Provenanced<{ calls: readonly OutgoingCall[] }>;
	"workspace.populateSymbolGraph": PopulateSymbolGraphResult;
	"workspace.reachableFrom": { symbols: readonly SymbolNode[] };
	"workspace.symbolEdgesFrom": { symbols: readonly SymbolNode[] };
	"workspace.symbolEdgesTo": { symbols: readonly SymbolNode[] };
	"workspace.hasWarmIndex": { warm: boolean };
	"workspace.cacheStatus": WorkspaceCacheStatus;
	"workspace.referenceBasedRename": ReferenceBasedRenameOutcome;
	"workspace.prepareRename": Provenanced<{ range: RenameRange | null }>;
	"workspace.rename": Provenanced<{ touchedPaths: readonly string[] }>;
	"workspace.gitStatus": GitStatusSummary;
	"workspace.gitLog": { entries: readonly GitLogEntry[] };
	"workspace.gitDiff": GitDiffResult;
	"workspace.compareSymbolAcrossVersions": {
		readonly path: string;
		readonly symbolName: string;
		readonly fromRef: string;
		/** Echoes the literal string "working tree" when toRef was omitted from the request. */
		readonly toRef: string;
		readonly status: SymbolComparisonStatus;
		readonly diff: string;
		readonly truncated: boolean;
	};
	"repo.fetch": RepoFetchResult & { workspaceId: WorkspaceId };
	"repo.listCache": CachedRepositoryPage;
	"repo.evictCache": { evicted: boolean };
	"package.resolveSource": PackageSourceOperationResult;
	"package.listSources": { entries: readonly PackageSourceListEntry[]; nextCursor: string | null };
	"package.removeSource": { removed: boolean };
	"package.cleanSources": { removed: number; skipped: number };
	"search.githubRepos": GithubRepoSearchResult;
	"search.npmPackages": { candidates: readonly NpmPackageCandidate[] };
	"search.sourcegraphCode": { candidates: readonly SourcegraphCodeCandidate[] };
	"workspace.searchText": TextSearchResult;
	"workspace.findFiles": FindFilesResult;
	"workspace.watch": { watchId: string; topic: string };
	"workspace.unwatch": { unwatched: boolean };
	"search.symbols": { results: readonly WorkspaceQueryOutcome<SymbolSearchResult>[] };
	"search.text": { results: readonly WorkspaceQueryOutcome<TextSearchResult>[] };
	"job.submit": { job: JobSnapshot<PopulateSymbolGraphResult> };
	"job.status": { job: JobSnapshot<PopulateSymbolGraphResult> };
	"job.watch": { watchId: JobWatchId; topic: JobTopic };
	"workspace.createAnnotation": { annotation: SymbolAnnotation };
	"workspace.getAnnotation": { annotation: SymbolAnnotation | undefined };
	"workspace.listAnnotations": { annotations: readonly SymbolAnnotation[] };
	"workspace.refreshAnnotation": { annotation: SymbolAnnotation | undefined };
	"workspace.scrubAnnotation": { scrubbed: boolean };
	"workspace.restoreAnnotation": { restored: boolean };
	"workspace.containAnnotation": { contained: boolean };
	"workspace.uncontainAnnotation": { uncontained: boolean };
	"workspace.annotationTree": { annotations: readonly SymbolAnnotation[] };
	"workspace.map": WorkspaceMapResult;
}

/**
 * Deterministically derive a workspaceId from a resolved absolute path, so the same
 * directory always yields the same id -- across repeat calls AND across a daemon
 * restart, since nothing about this derivation depends on runtime/in-memory state.
 * A shorter digest than ContentHash's is deliberate: this identifies a workspace root
 * for addressing/logging, not a content value needing full collision resistance.
 */
export function deriveWorkspaceId(absolutePath: string): WorkspaceId {
	return createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
}

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

export interface RegisteredWorkspace {
	readonly port: WorkspacePort;
	/** Present only for workspaces registered via workspace.registerPath -- required for symbol queries. */
	readonly rootPath?: string;
	/** Local work always outranks disposable fetched-repo work in the bounded job queue. */
	readonly origin: "local" | "remote";
	/** Present only for a workspace registered via repo.fetch -- the reference to re-check/refetch when its remote moves. */
	readonly remoteReference?: RepoReference;
}

export type MutableRegistry = Map<WorkspaceId, RegisteredWorkspace>;

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

export function resolveWorkspace(registry: MutableRegistry, workspaceId: WorkspaceId): WorkspacePort {
	const entry = registry.get(workspaceId);
	if (!entry) throw new UnknownWorkspace(workspaceId);
	return entry.port;
}

/** True when a WorkspacePort also implements FileTreePort -- mirrors supportsCodeIntelligence's own duck-typed capability check below. */
function supportsFileTree(port: WorkspacePort): port is WorkspacePort & FileTreePort {
	return "listDirectory" in port && typeof port.listDirectory === "function";
}

/** Raised when a workspace's own WorkspacePort implementation does not also implement FileTreePort (e.g. a read-only fetched-repo checkout). */
export class WorkspaceDoesNotSupportFileTree extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}" does not support directory-tree operations`);
		this.name = "WorkspaceDoesNotSupportFileTree";
	}
}

function resolveFileTree(registry: MutableRegistry, workspaceId: WorkspaceId): FileTreePort {
	const port = resolveWorkspace(registry, workspaceId);
	if (!supportsFileTree(port)) throw new WorkspaceDoesNotSupportFileTree(workspaceId);
	return port;
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

/**
 * How long search.symbols/search.text wait for one workspace's own query before reporting it as
 * "loading" and moving on -- generous enough for typical cold-start (TypeScript/Python/Go/C++/
 * Bash/YAML all settle well under 3s; only rust-analyzer's own measured ~2.5s worst case comes
 * close), bounded so one slow workspace can't stall every other workspace's real results.
 */
const MAX_INITIAL_JOB_WAIT_MS = 30_000;
const MAX_SYMBOL_RESULTS = 5_000;
const MAX_SOURCE_MANIFEST_BYTES = 50 * 1024 * 1024;
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

	// One annotation store per workspace, lazily created on first use.
	const symbolAnnotations = new Map<WorkspaceId, SymbolAnnotationPort>();
	const createSymbolAnnotations = options.createSymbolAnnotations ?? (() => new InMemorySymbolAnnotations());

	function ensureSymbolAnnotations(workspaceId: WorkspaceId): SymbolAnnotationPort {
		let store = symbolAnnotations.get(workspaceId);
		if (!store) {
			store = createSymbolAnnotations(workspaceId);
			symbolAnnotations.set(workspaceId, store);
		}
		return store;
	}

	const mutationHistory = new MutationHistoryCoordinator({ registry, createStore: options.createMutationHistory });

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
	const watchRegistry = new WatchRegistry();
	/** Serializes workspace.rename's atomic multi-file apply per workspace root -- a concurrent second rename (or reference-based rename) for the same workspace waits its turn rather than interleaving mid-apply. */
	const renameMutationBarrier = new SerialExecutionQueue();
	/**
	 * One real OS watcher per workspace, shared across every pattern registered for it AND
	 * graph-freshness watching -- lazily created on the first workspace.watch call or the first
	 * successful population (whichever comes first), closed only once BOTH reasons are gone
	 * (see GraphRefreshCoordinator).
	 */
	const osWatchersByWorkspace = new Map<WorkspaceId, { close(): void }>();

	/** Ensures a workspace's shared OS watcher exists, for either reason (agent watch or graph freshness) -- idempotent, safe to call when one already exists for the other reason. */
	function ensureOsWatcher(workspaceId: WorkspaceId, rootPath: string): void {
		if (osWatchersByWorkspace.has(workspaceId)) return;
		const handle = createFileWatcher().watch(rootPath, (event) => handleFileChange(workspaceId, event));
		osWatchersByWorkspace.set(workspaceId, handle);
	}

	/**
	 * Submits a fresh background population for `workspaceId` using its last generation's own
	 * bounds, deduplicated against any already-in-flight population the same way
	 * job.submit's own dedup works. If a population is already running, re-arms the debounce
	 * instead of dropping this change silently -- once the in-flight run settles (success or
	 * the protective WorkspaceChangedDuringPopulation failure a genuinely concurrent change can
	 * trigger), a fresh run picks up the current state rather than the change being lost forever.
	 */
	async function scheduleGraphRefresh(workspaceId: WorkspaceId): Promise<void> {
		const workspace = registry.get(workspaceId);
		if (!workspace) return; // workspace no longer known -- nothing to refresh
		const existingJobId = graphRefresh.activeJob(workspaceId);
		if (existingJobId) {
			const existing = jobs.status(existingJobId);
			if (existing.status === "queued" || existing.status === "running") {
				graphRefresh.schedule(workspaceId, () => {
					void scheduleGraphRefresh(workspaceId);
				});
				return;
			}
			graphRefresh.clearActiveJob(workspaceId);
		}
		const generation = await graphRefresh.graph(workspaceId).getGeneration();
		if (!generation) return; // never populated (or its cache was reset) -- nothing to keep warm
		const input = { workspaceId, maxFiles: generation.maxFiles, maxSymbolsPerFile: generation.maxSymbolsPerFile };
		let submittedJobId = "";
		const submitted = jobs.submit({
			operation: "workspace.populateSymbolGraph",
			priority: workspace.origin,
			run: async () => {
				try {
					return await populateSymbolGraphHandler(registry, input);
				} finally {
					graphRefresh.clearActiveJob(workspaceId, submittedJobId);
				}
			},
		});
		submittedJobId = submitted.id;
		graphRefresh.setActiveJob(workspaceId, submitted.id);
	}

	const gitHandlers = createGitHandlers({ registry, createGitPort, logger });
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
	const crossWorkspaceHandlers = createCrossWorkspaceHandlers({
		registry,
		findSymbols: (input) => findSymbols(registry, input),
		searchText: (input) => searchTextHandler(registry, input),
	});

	async function searchTextHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.searchText"],
	): Promise<OperationOutputs["workspace.searchText"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		return searchTextQuery(textSearch, searchCache, entry.rootPath, input.workspaceId, input.query, { maxMatches: input.maxMatches, maxBytes: input.maxBytes });
	}

	async function findFilesHandler(registry: MutableRegistry, input: OperationInputs["workspace.findFiles"]): Promise<OperationOutputs["workspace.findFiles"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		return findFilesQuery(textSearch, entry.rootPath, input.patterns, { maxResults: input.maxResults, maxBytes: input.maxBytes });
	}

	/**
	 * The one callback every workspace's single shared OS watcher uses, regardless of how many
	 * patterns are registered against it. Three independent effects, none gating the others:
	 * (1) dispatch to every agent-registered workspace.watch pattern, publishing to each match's
	 * own topic; (2) forward to the workspace's warm code-intelligence index(es), which decide
	 * for themselves (via their own dynamically registered LSP patterns) whether the server cares;
	 * (3) schedule a debounced automatic symbol-graph refresh if this workspace has ever been
	 * populated.
	 */
	function handleFileChange(workspaceId: WorkspaceId, event: FileChangeEvent): void {
		for (const registration of watchRegistry.registrationsFor(workspaceId)) {
			if (picomatch(registration.pattern)(event.path)) publish(registration.topic, event);
		}
		warmIndexes.notifyFileChanged(workspaceId, event);
		// git's own internal bookkeeping (index, refs, packed-refs, objects, logs, ...) writes real
		// files under .git/ on every status check/commit -- none of it is source code, and the
		// automatic graph watcher requiring a real git repository (see populateSymbolGraphHandler)
		// means this noise is now guaranteed to exist for every graph-watched workspace, not a rare
		// case. Explicit workspace.watch/notifyFileChanged keep seeing it -- only the graph-refresh
		// trigger, which never has a legitimate reason to react to .git's own internals, excludes it.
		const isGitInternal = event.path === ".git" || event.path.startsWith(".git/");
		if (!isGitInternal && graphRefresh.isWatched(workspaceId)) {
			graphRefresh.schedule(workspaceId, () => {
				void scheduleGraphRefresh(workspaceId);
			});
		}
	}

	async function watchHandler(registry: MutableRegistry, input: OperationInputs["workspace.watch"]): Promise<OperationOutputs["workspace.watch"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		if (!input.pattern) throw new TypeError("workspace.watch requires a non-empty pattern");

		const watchId = randomUUID();
		const topic = `watch:${watchId}`;
		// Registered before the OS watcher is (possibly) created: if WatchLimitExceeded throws
		// here, no OS watcher is ever touched for a workspace already at its bound.
		watchRegistry.add(input.workspaceId, input.pattern, watchId, topic);

		ensureOsWatcher(input.workspaceId, entry.rootPath);

		return { watchId, topic };
	}

	async function unwatchHandler(_registry: MutableRegistry, input: OperationInputs["workspace.unwatch"]): Promise<OperationOutputs["workspace.unwatch"]> {
		const removed = watchRegistry.remove(input.watchId);
		// Only close the shared OS watcher once NEITHER reason to keep it open remains -- a
		// workspace whose graph is being kept warm must keep observing disk changes even after
		// every agent-registered watch on it is gone.
		if (removed && !watchRegistry.hasAnyFor(removed.workspaceId) && !graphRefresh.isWatched(removed.workspaceId)) {
			osWatchersByWorkspace.get(removed.workspaceId)?.close();
			osWatchersByWorkspace.delete(removed.workspaceId);
		}
		return { unwatched: removed !== undefined };
	}

	/** Never spawns -- a caller deciding whether to enrich a result with LSP-backed info must not pay a cold-start cost just to check. With a path, checks that file's own language; without one, whether anything is warm for the workspace at all. */
	async function hasWarmIndex(
		registry: MutableRegistry,
		input: OperationInputs["workspace.hasWarmIndex"],
	): Promise<OperationOutputs["workspace.hasWarmIndex"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		return { warm: warmIndexes.hasWarmIndex(input.workspaceId, input.path) };
	}

	async function findSymbols(_registry: MutableRegistry, input: OperationInputs["workspace.findSymbols"]): Promise<OperationOutputs["workspace.findSymbols"]> {
		assertBoundedSymbolQuery(input.query);
		const maxResults = input.maxResults ?? 1_000;
		if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_SYMBOL_RESULTS) {
			throw new TypeError(`maxResults must be a positive safe integer no greater than ${MAX_SYMBOL_RESULTS}`);
		}
		const { index } = warmIndexes.ensureWorkspaceIndex(input.workspaceId, input.seedFile);
		const result = await findWorkspaceSymbols(index, input.query, { maxResults });
		// "concise" narrows the actual JSON payload per domain/response-format.ts; the declared
		// output type stays SymbolSearchResult (this operation's default, and every untouched
		// caller's honest shape) -- a caller that opts into responseFormat:"concise" already knows
		// to treat fields absent from the concise contract as absent, not to trust this type for it.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- see comment above
		return formatSymbolSearchResult(result, input.responseFormat ?? "detailed") as OperationOutputs["workspace.findSymbols"];
	}

	async function requireCodeIntelligence(input: {
		workspaceId: WorkspaceId;
		path?: string;
		seedFile?: string;
	}): Promise<{ index: SymbolIndexPort & CodeIntelligencePort; descriptor: LanguageServerDescriptor }> {
		const { index, descriptor } = warmIndexes.ensureWarmIndex(input);
		if (!supportsCodeIntelligence(index)) throw new CodeIntelligenceUnavailable(input.workspaceId);
		return { index, descriptor };
	}

	async function goToDefinition(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.goToDefinition"],
	): Promise<OperationOutputs["workspace.goToDefinition"]> {
		const { index } = await requireCodeIntelligence(input);
		const locations = await goToDefinitionQuery(index, { path: input.path, line: input.line, character: input.character });
		return { locations, provenance: index.provenance };
	}

	async function goToImplementation(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.goToImplementation"],
	): Promise<OperationOutputs["workspace.goToImplementation"]> {
		const { index } = await requireCodeIntelligence(input);
		const locations = await goToImplementationQuery(index, { path: input.path, line: input.line, character: input.character });
		return { locations, provenance: index.provenance };
	}

	async function findReferences(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.findReferences"],
	): Promise<OperationOutputs["workspace.findReferences"]> {
		const { index } = await requireCodeIntelligence(input);
		const locations = await findReferencesQuery(index, { path: input.path, line: input.line, character: input.character }, input.includeDeclaration);
		// See findSymbols' identical note on the concise/detailed type-vs-runtime tradeoff.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		return formatProvenanced({ locations, provenance: index.provenance }, input.responseFormat ?? "detailed") as OperationOutputs["workspace.findReferences"];
	}

	async function hover(_registry: MutableRegistry, input: OperationInputs["workspace.hover"]): Promise<OperationOutputs["workspace.hover"]> {
		const { index } = await requireCodeIntelligence(input);
		const hover = await hoverAt(index, { path: input.path, line: input.line, character: input.character });
		return { hover, provenance: index.provenance };
	}

	async function documentSymbolsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.documentSymbols"],
	): Promise<OperationOutputs["workspace.documentSymbols"]> {
		const { index } = await requireCodeIntelligence(input);
		const symbols = await documentSymbolsQuery(index, input.path);
		return { symbols, provenance: index.provenance };
	}

	async function diagnosticsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.diagnostics"],
	): Promise<OperationOutputs["workspace.diagnostics"]> {
		const { index } = await requireCodeIntelligence(input);
		const diagnostics = await diagnosticsQuery(index, input.path);
		return { diagnostics, provenance: index.provenance };
	}

	async function prepareCallHierarchyHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.prepareCallHierarchy"],
	): Promise<OperationOutputs["workspace.prepareCallHierarchy"]> {
		const { index } = await requireCodeIntelligence(input);
		const items = await prepareCallHierarchyQuery(index, { path: input.path, line: input.line, character: input.character });
		return { items, provenance: index.provenance };
	}

	async function incomingCallsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.incomingCalls"],
	): Promise<OperationOutputs["workspace.incomingCalls"]> {
		const { index } = await requireCodeIntelligence(input);
		const calls = await incomingCallsQuery(index, { path: input.path, line: input.line, character: input.character });
		return { calls, provenance: index.provenance };
	}

	async function outgoingCallsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.outgoingCalls"],
	): Promise<OperationOutputs["workspace.outgoingCalls"]> {
		const { index } = await requireCodeIntelligence(input);
		const calls = await outgoingCallsQuery(index, { path: input.path, line: input.line, character: input.character });
		return { calls, provenance: index.provenance };
	}

	/**
	 * The git HEAD sha to record with a fresh generation, or undefined when the workspace isn't
	 * a git repository or its tree wasn't clean at population time -- either way, no single sha
	 * can honestly represent "the state this generation was built from." Never throws: any git
	 * error just means this workspace's future cache-status checks always pay for a full rehash,
	 * not that population itself should fail.
	 */
	async function captureGitHeadShaIfClean(rootPath: string): Promise<string | undefined> {
		try {
			const git = createGitPort(rootPath);
			if (!(await git.isGitRepository())) return undefined;
			const status = await git.status();
			if (status.files.length > 0) return undefined;
			const [latest] = await git.log(1);
			return latest?.sha;
		} catch {
			return undefined;
		}
	}

	/**
	 * False on any git error, not just a genuine mismatch -- an errored fast-path check must
	 * never be trusted as "fresh," only ever fall back to the full rehash. Deliberately skips a
	 * separate isGitRepository() probe: status()/log() on a non-repo fail on their own, caught
	 * the same way, at one fewer subprocess spawn -- confirmed to matter empirically (a real
	 * measured ~20% of this check's own cost at production-relevant tree sizes), not a guessed
	 * micro-optimization.
	 */
	async function isCacheFreshViaGit(rootPath: string, recordedHeadSha: string): Promise<boolean> {
		try {
			const git = createGitPort(rootPath);
			const status = await git.status();
			const [latest] = await git.log(1);
			return isCacheFreshByGit({ recordedHeadSha, isGitRepository: true, workingTreeClean: status.files.length === 0, currentHeadSha: latest?.sha });
		} catch {
			return false;
		}
	}

	/**
	 * Closes and forgets any warm symbol index for this workspace, without touching another
	 * workspace's. Called after a forced remote refetch replaces the workspace's on-disk
	 * directory wholesale -- an already-warm LSP process (e.g. tsserver) has its own project
	 * state built from the old directory and does not recover from having it swapped out from
	 * under it (confirmed live: querying it afterwards failed with "No Project"). The next
	 * ensureLanguageIndex call for this workspace spawns a fresh process against the new content.
	 */
	async function closeWarmIndexesForWorkspace(workspaceId: WorkspaceId): Promise<void> {
		await warmIndexes.closeWorkspace(workspaceId);
	}

	/**
	 * Auto-pull, on demand, no debounce: every call against a remote-tracked workspace pays one
	 * cheap ls-remote; a real refetch only happens on the call where the remote's commit actually
	 * differs from what the last generation recorded. A no-op for a local workspace, a remote
	 * workspace with no prior generation to compare against, or an inconclusive remote check
	 * (shouldRefetchFromRemote never treats "couldn't tell" as evidence of staleness). The
	 * refetch reuses repoFetcher's own atomic clone-into-tmp-then-rename swap at the exact same
	 * on-disk path this workspace is already registered against, so no registry update is needed
	 * -- the next read of rootPath simply sees the fresh content.
	 */
	async function refreshRemoteWorkspaceIfMoved(
		workspaceId: WorkspaceId,
		entry: RegisteredWorkspace,
		previousGeneration: SymbolGraphGeneration | undefined,
	): Promise<void> {
		if (!entry.remoteReference || !repoFetcher) return;
		const currentRemoteCommit = await repoFetcher.resolveRemoteCommit(entry.remoteReference);
		if (!shouldRefetchFromRemote({ recordedCommit: previousGeneration?.remoteCommit, currentRemoteCommit })) return;
		await repoFetcher.fetch(entry.remoteReference, { forceRefresh: true });
		await closeWarmIndexesForWorkspace(workspaceId);
	}

	async function populateSymbolGraphHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	): Promise<OperationOutputs["workspace.populateSymbolGraph"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry?.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		const rootPath = entry.rootPath;
		const graph = ensureSymbolGraph(input.workspaceId);
		// Purge before repopulating: a file walked last generation but absent from this one was
		// deleted (or moved out of scope), and its stale nodes/edges must not survive indefinitely.
		const previousGeneration = await graph.getGeneration();
		// A remote-tracked workspace whose origin has moved past the last recorded commit is
		// refetched in place, and any already-warm index evicted, BEFORE ensureWorkspaceIndex
		// below -- an already-warm LSP process built its own project state from the old
		// directory and does not survive having it swapped out from under it, and "before"
		// further down must see the freshly-fetched content, not what was on disk previously.
		await refreshRemoteWorkspaceIfMoved(input.workspaceId, entry, previousGeneration);
		const workspaceIndex = warmIndexes.ensureWorkspaceIndex(input.workspaceId);
		if (!supportsCodeIntelligence(workspaceIndex.index)) throw new CodeIntelligenceUnavailable(input.workspaceId);
		const extensions = warmIndexes.sourceExtensions(workspaceIndex.descriptors);
		const before = await deriveSourceManifest(rootPath, extensions, input.maxFiles, MAX_SOURCE_MANIFEST_BYTES);
		await purgeFilesNoLongerWalked(graph, previousGeneration?.walkedFiles, before.absoluteFiles);
		const result = await populateSymbolGraphQuery(workspaceIndex.index, graph, before.absoluteFiles, input.maxSymbolsPerFile, logger);
		const after = await deriveSourceManifest(rootPath, extensions, input.maxFiles, MAX_SOURCE_MANIFEST_BYTES);
		if (after.fingerprint !== before.fingerprint) throw new WorkspaceChangedDuringPopulation(input.workspaceId);
		await graph.setGeneration({
			sourceFingerprint: after.fingerprint,
			maxFiles: input.maxFiles,
			maxSymbolsPerFile: input.maxSymbolsPerFile,
			completedAt: Date.now(),
			provenance: workspaceIndex.index.provenance,
			sources: workspaceIndex.sources,
			result,
			gitHeadSha: await captureGitHeadShaIfClean(rootPath),
			walkedFiles: before.absoluteFiles,
			remoteReference: entry.remoteReference,
			remoteCommit: entry.remoteReference ? await repoFetcher?.resolveRemoteCommit(entry.remoteReference) : undefined,
		});
		// A workspace that has been populated at least once stays graph-watched for the rest of
		// the daemon's uptime -- the whole point of "keeps the symbol graph warm on disk changes".
		// Gated on being a real git repository: a raw, non-git directory (workspaceForPath's own
		// intentional fs-root/scratch-file fallback, or any other broad/ambiguous root) must never
		// get an automatic, unbounded OS-level recursive watcher armed against it -- confirmed live
		// as a real resource-exhaustion/runaway-process incident. populateSymbolGraph itself still
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
		await refreshRemoteWorkspaceIfMoved(input.workspaceId, entry, generation);
		// Fast path: skip the full source rehash below entirely when git alone already proves
		// nothing changed (same clean tree, same HEAD). Inconclusive (no recorded sha, dirty tree,
		// moved HEAD, any git error) always falls through to the authoritative full check --
		// this path can only ever short-circuit to the SAME answer the full check would give,
		// never a different one.
		if (generation.gitHeadSha !== undefined && (await isCacheFreshViaGit(entry.rootPath, generation.gitHeadSha))) {
			return generation.result.completeness === "partial" ? { status: "partial", generation } : { status: "cached", generation };
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
		return generation.result.completeness === "partial" ? { status: "partial", generation } : { status: "cached", generation };
	}

	/** Every top-level document symbol's own selectionRange -- deliberately not descending into `children` (a class method can't itself be reached via a module specifier, only the file's own top-level exports can be). */
	function flattenTopLevelPositions(symbols: readonly DocumentSymbolEntry[], path: string): Array<{ path: string; line: number; character: number }> {
		return symbols.map((symbol) => ({ path, line: symbol.selectionRange.start.line, character: symbol.selectionRange.start.character }));
	}

	async function referenceBasedRenameHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.referenceBasedRename"],
	): Promise<OperationOutputs["workspace.referenceBasedRename"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);

		// Point 6 of this operation's own design: refuse outright, before touching anything, unless
		// the symbol graph is fully "cached" for these exact bounds -- a "partial" or "not-cached"
		// graph cannot honestly enumerate every reference, and CodeScaleBench's own finding is that a
		// partial multi-file change scores WORSE than no change at all.
		const status = await cacheStatusHandler(registry, { workspaceId: input.workspaceId, maxFiles: input.maxFiles, maxSymbolsPerFile: input.maxSymbolsPerFile });
		if (status.status !== "cached") throw new ReferenceBasedRenameRequiresFreshGraph(input.workspaceId, status.status);

		const fromPath = entry.port.resolvePath(input.fromPath);
		const toPath = entry.port.resolvePath(input.toPath);

		const { index } = await requireCodeIntelligence({ workspaceId: input.workspaceId, path: fromPath });
		const topLevelSymbols = await documentSymbolsQuery(index, fromPath);
		const positions = flattenTopLevelPositions(topLevelSymbols, fromPath);

		const referencingPaths = new Set<string>();
		for (const position of positions) {
			const locations = await findReferencesQuery(index, { path: position.path, line: position.line, character: position.character }, false);
			for (const location of locations) {
				const locationPath = entry.port.resolvePath(location.path);
				if (locationPath !== fromPath) referencingPaths.add(locationPath);
			}
		}

		const referencingFiles = [];
		for (const path of referencingPaths) {
			const read = await entry.port.readEntry(path);
			if (!read.exists) continue;
			const hash = contentHashOf(read.content);
			const importSpecifiers = await findImportSpecifiers(read.content, extname(path));
			referencingFiles.push({ path, content: read.content, hash, importSpecifiers });
		}

		const movedFile = await entry.port.readEntry(fromPath);
		if (!movedFile.exists) throw new WorkspaceEntryNotFound(fromPath);

		const plan = planReferenceBasedRename({
			fromPath,
			toPath,
			movedFileContent: movedFile.content,
			movedFileHash: contentHashOf(movedFile.content),
			referencingFiles,
		});

		return applyReferenceBasedRename(entry.port, plan);
	}

	async function prepareRenameHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.prepareRename"],
	): Promise<OperationOutputs["workspace.prepareRename"]> {
		const { index } = await requireCodeIntelligence(input);
		if (!index.prepareRename) throw new RenameNotSupported(input.workspaceId);
		const range = await index.prepareRename({ path: input.path, line: input.line, character: input.character });
		return { range, provenance: index.provenance };
	}

	async function renameHandler(_registry: MutableRegistry, input: OperationInputs["workspace.rename"]): Promise<OperationOutputs["workspace.rename"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		const { index } = await requireCodeIntelligence(input);
		if (!index.rename) throw new RenameNotSupported(input.workspaceId);
		const rename = index.rename.bind(index);

		return renameMutationBarrier.run(input.workspaceId, async () => {
			const edit: ParsedWorkspaceEdit = await rename({ path: input.path, line: input.line, character: input.character }, input.newName);
			const renamePairs = edit.operations.filter((op) => op.kind === "rename").map((op) => ({ fromPath: op.fromPath, toPath: op.toPath }));

			// The caller's own snapshot of every touched path's current hash -- taken immediately
			// before applying, as close as Lector can get to "what the server actually saw" without
			// re-running its own analysis. applyWorkspaceEdit validates every step against this,
			// never a fresh read taken mid-apply (see its own doc comment for why that would catch
			// nothing).
			const expectedHashes = new Map<string, ContentHash | null>();
			for (const path of collectTouchedPaths(edit)) {
				const read = await entry.port.readEntry(path);
				expectedHashes.set(path, read.exists ? contentHashOf(read.content) : null);
			}

			await index.notifyFilesWillRename?.(renamePairs);
			const outcome = await applyWorkspaceEdit(entry.port, edit, expectedHashes);
			index.notifyFilesDidRename?.(renamePairs);

			return { touchedPaths: outcome.touchedPaths, provenance: index.provenance };
		});
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
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
		const workspace = registry.get(workspaceId);
		if (!workspace) throw new UnknownWorkspace(workspaceId);
		const existingJobId = graphRefresh.activeJob(workspaceId);
		if (existingJobId) {
			const existing = jobs.status(existingJobId);
			if (existing.status === "queued" || existing.status === "running") {
				return { job: waitMs === 0 ? existing : await jobs.wait(existing.id, waitMs) };
			}
			graphRefresh.clearActiveJob(workspaceId);
		}
		const input = { workspaceId, maxFiles, maxSymbolsPerFile };
		let submittedJobId = "";
		const submitted = jobs.submit({
			operation,
			priority: workspace.origin,
			run: async () => {
				try {
					return await populateSymbolGraphHandler(registry, input);
				} finally {
					graphRefresh.clearActiveJob(workspaceId, submittedJobId);
				}
			},
		});
		submittedJobId = submitted.id;
		graphRefresh.setActiveJob(workspaceId, submitted.id);
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

	async function reachableFromHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.reachableFrom"],
	): Promise<OperationOutputs["workspace.reachableFrom"]> {
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await reachableSymbolsFrom(graph, id, { maxDepth: input.maxDepth, kind: input.kind });
		return { symbols };
	}

	async function symbolEdgesFromHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesFrom"],
	): Promise<OperationOutputs["workspace.symbolEdgesFrom"]> {
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await symbolEdgesFrom(graph, id, input.kind);
		return { symbols };
	}

	async function symbolEdgesToHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesTo"],
	): Promise<OperationOutputs["workspace.symbolEdgesTo"]> {
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await symbolEdgesTo(graph, id, input.kind);
		return { symbols };
	}

	/** Positions only in, real anchors out -- symbolNodeId and the baseline file hash are derived server-side from the live graph/workspace, never trusted from the caller. */
	async function resolveAnnotationAnchors(
		graph: SymbolGraphPort,
		workspace: WorkspacePort,
		positions: readonly { path: string; line: number; character: number }[],
	): Promise<SymbolAnnotationAnchor[]> {
		if (positions.length === 0) throw new AnnotationRequiresAnchors();
		const hashByPath = new Map<string, ContentHash>();
		const anchors: SymbolAnnotationAnchor[] = [];
		for (const position of positions) {
			// A caller may give a workspace-relative path (the convention every other path
			// argument in this service accepts); the graph's own node ids are always keyed by
			// whatever absolute form the language server reported, so resolve to that same
			// identity before deriving the id -- otherwise a perfectly correct relative anchor
			// looks indistinguishable from a genuinely unknown position.
			const resolvedPath = workspace.resolvePath(position.path);
			const resolvedPosition = { ...position, path: resolvedPath };
			const symbolNodeId = deriveSymbolNodeId(resolvedPosition);
			const node = await graph.getNode(symbolNodeId);
			if (!node) throw new UnknownAnnotationAnchor(position.path, position.line, position.character);
			let hash = hashByPath.get(resolvedPath);
			if (hash === undefined) {
				const entry = await workspace.readEntry(resolvedPath);
				if (!entry.exists) throw new UnknownAnnotationAnchor(position.path, position.line, position.character);
				hash = contentHashOf(entry.content);
				hashByPath.set(resolvedPath, hash);
			}
			anchors.push({ symbolNodeId, path: resolvedPath, fileContentHash: hash });
		}
		return anchors;
	}

	/**
	 * Option A: every read live-checks staleness against the current graph/workspace and
	 * persists a correction before returning -- a caller never sees a status that disagrees
	 * with reality, at the cost of a live check per read. Never touches a "scrubbed"
	 * annotation -- that status is a terminal, explicit caller decision staleness detection
	 * must not override.
	 */
	async function withLiveStatus(
		graph: SymbolGraphPort,
		workspace: WorkspacePort,
		store: SymbolAnnotationPort,
		annotation: SymbolAnnotation,
	): Promise<SymbolAnnotation> {
		if (annotation.status === "scrubbed") return annotation;
		const stale = await checkAnnotationStaleness(graph, workspace, annotation);
		const wantedStatus: "fresh" | "stale" = stale ? "stale" : "fresh";
		if (annotation.status === wantedStatus) return annotation;
		const updated = await store.setStatus(annotation.id, wantedStatus);
		return updated ?? annotation;
	}

	async function createAnnotationHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.createAnnotation"],
	): Promise<OperationOutputs["workspace.createAnnotation"]> {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const graph = ensureSymbolGraph(input.workspaceId);
		const anchors = await resolveAnnotationAnchors(graph, workspace, input.anchors);
		const store = ensureSymbolAnnotations(input.workspaceId);
		const annotation = await store.create({ subtype: input.subtype, title: input.title, body: input.body, anchors });
		return { annotation };
	}

	async function getAnnotationHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.getAnnotation"],
	): Promise<OperationOutputs["workspace.getAnnotation"]> {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const store = ensureSymbolAnnotations(input.workspaceId);
		const found = await store.get(input.id);
		if (!found) return { annotation: undefined };
		const graph = ensureSymbolGraph(input.workspaceId);
		return { annotation: await withLiveStatus(graph, workspace, store, found) };
	}

	async function listAnnotationsHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.listAnnotations"],
	): Promise<OperationOutputs["workspace.listAnnotations"]> {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const store = ensureSymbolAnnotations(input.workspaceId);
		const graph = ensureSymbolGraph(input.workspaceId);
		const listOptions: SymbolAnnotationListOptions = { subtype: input.subtype, status: input.status, maxResults: input.maxResults, query: input.query };
		const found = await store.list(listOptions);
		const annotations = await Promise.all(found.map((annotation) => withLiveStatus(graph, workspace, store, annotation)));
		return { annotations };
	}

	async function refreshAnnotationHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.refreshAnnotation"],
	): Promise<OperationOutputs["workspace.refreshAnnotation"]> {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const graph = ensureSymbolGraph(input.workspaceId);
		const anchors = await resolveAnnotationAnchors(graph, workspace, input.anchors);
		const store = ensureSymbolAnnotations(input.workspaceId);
		const annotation = await store.refresh(input.id, { subtype: input.subtype, title: input.title, body: input.body, anchors });
		return { annotation };
	}

	async function scrubAnnotationHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.scrubAnnotation"],
	): Promise<OperationOutputs["workspace.scrubAnnotation"]> {
		resolveWorkspace(registry, input.workspaceId);
		const store = ensureSymbolAnnotations(input.workspaceId);
		return { scrubbed: await store.scrub(input.id) };
	}

	async function restoreAnnotationHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.restoreAnnotation"],
	): Promise<OperationOutputs["workspace.restoreAnnotation"]> {
		resolveWorkspace(registry, input.workspaceId);
		const store = ensureSymbolAnnotations(input.workspaceId);
		return { restored: await store.restore(input.id) };
	}

	async function containAnnotationHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.containAnnotation"],
	): Promise<OperationOutputs["workspace.containAnnotation"]> {
		resolveWorkspace(registry, input.workspaceId);
		const store = ensureSymbolAnnotations(input.workspaceId);
		if (!(await store.get(input.parentId))) throw new UnknownAnnotationForContainment(input.parentId);
		if (!(await store.get(input.childId))) throw new UnknownAnnotationForContainment(input.childId);
		if (await wouldCreateContainmentCycle(store, input.parentId, input.childId)) {
			throw new AnnotationContainmentCycle(input.parentId, input.childId);
		}
		return { contained: await store.addContainmentEdge(input.parentId, input.childId) };
	}

	async function uncontainAnnotationHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.uncontainAnnotation"],
	): Promise<OperationOutputs["workspace.uncontainAnnotation"]> {
		resolveWorkspace(registry, input.workspaceId);
		const store = ensureSymbolAnnotations(input.workspaceId);
		return { uncontained: await store.removeContainmentEdge(input.parentId, input.childId) };
	}

	async function annotationTreeHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.annotationTree"],
	): Promise<OperationOutputs["workspace.annotationTree"]> {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const store = ensureSymbolAnnotations(input.workspaceId);
		const graph = ensureSymbolGraph(input.workspaceId);
		const found = await annotationsContainedFrom(store, input.rootId, input.maxDepth);
		const annotations = await Promise.all(found.map((annotation) => withLiveStatus(graph, workspace, store, annotation)));
		return { annotations };
	}

	async function workspaceMapHandler(registry: MutableRegistry, input: OperationInputs["workspace.map"]): Promise<OperationOutputs["workspace.map"]> {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const graph = ensureSymbolGraph(input.workspaceId);
		return computeWorkspaceMap(graph, workspace, {
			maxNodes: input.maxNodes,
			maxEdges: input.maxEdges,
			maxEntries: input.maxEntries,
			maxBytes: input.maxBytes,
		});
	}

	const handlers: OperationHandlers = {
		"workspace.listDirectory": (registry, input) => listDirectory(resolveFileTree(registry, input.workspaceId), input.path),
		"workspace.createDirectory": async (registry, input) => {
			await resolveFileTree(registry, input.workspaceId).createDirectory(input.path);
			return { path: input.path };
		},
		"workspace.renamePath": async (registry, input) => {
			await resolveFileTree(registry, input.workspaceId).renamePath(input.oldPath, input.newPath);
			return { oldPath: input.oldPath, newPath: input.newPath };
		},
		"workspace.deleteDirectory": async (registry, input) => {
			await resolveFileTree(registry, input.workspaceId).deleteDirectory(input.path);
			return { path: input.path };
		},
		"workspace.rawRead": async (registry, input) => {
			const read = await rawRead(resolveWorkspace(registry, input.workspaceId), input.path);
			await contentCache.putRawContent(read.hash, read.content);
			return read;
		},
		"workspace.exactEdit": async (registry, input) => {
			const { workspaceId, ...edit } = input;
			const outcome = await mutationHistory.record(workspaceId, edit.path, "exactEdit", () => exactEdit(resolveWorkspace(registry, workspaceId), edit));
			await contentCache.putRawContent(outcome.newHash, edit.content);
			return outcome;
		},
		"workspace.deleteEntry": async (registry, input) => {
			const outcome = await mutationHistory.record(input.workspaceId, input.path, "delete", async () => {
				const result = await resolveWorkspace(registry, input.workspaceId).deleteEntry(input.path, input.expectedHash);
				return { newHash: null, previousHash: result.previousHash };
			});
			return { path: input.path, previousHash: outcome.previousHash };
		},
		"workspace.lineEdit": (registry, input) => {
			return mutationHistory.record(input.workspaceId, input.path, "lineEdit", () =>
				lineEdit(resolveWorkspace(registry, input.workspaceId), { path: input.path, edits: input.edits }),
			);
		},
		"workspace.applyPatch": (registry, input) => {
			return mutationHistory.record(input.workspaceId, input.path, "applyPatch", () =>
				applyPatch(resolveWorkspace(registry, input.workspaceId), { path: input.path, expectedHash: input.expectedHash, patchText: input.patchText }),
			);
		},
		"workspace.registerPath": registerPath,
		"workspace.findSymbols": findSymbols,
		"workspace.goToDefinition": goToDefinition,
		"workspace.goToImplementation": goToImplementation,
		"workspace.findReferences": findReferences,
		"workspace.hover": hover,
		"workspace.documentSymbols": documentSymbolsHandler,
		"workspace.diagnostics": diagnosticsHandler,
		"workspace.prepareCallHierarchy": prepareCallHierarchyHandler,
		"workspace.incomingCalls": incomingCallsHandler,
		"workspace.outgoingCalls": outgoingCallsHandler,
		"workspace.populateSymbolGraph": populateSymbolGraphHandler,
		"workspace.reachableFrom": reachableFromHandler,
		"workspace.symbolEdgesFrom": symbolEdgesFromHandler,
		"workspace.symbolEdgesTo": symbolEdgesToHandler,
		"workspace.hasWarmIndex": hasWarmIndex,
		"workspace.cacheStatus": cacheStatusHandler,
		"workspace.referenceBasedRename": referenceBasedRenameHandler,
		"workspace.prepareRename": prepareRenameHandler,
		"workspace.rename": renameHandler,
		...gitHandlers,
		...repoFetchHandlers,
		...packageSourceHandlers,
		...mutationHistory.handlers,
		...externalSearchHandlers,
		...crossWorkspaceHandlers,
		"workspace.searchText": searchTextHandler,
		"workspace.findFiles": findFilesHandler,
		"workspace.watch": watchHandler,
		"workspace.unwatch": unwatchHandler,
		"job.submit": submitJobHandler,
		"job.status": jobStatusHandler,
		"job.watch": jobWatchHandler,
		"workspace.createAnnotation": createAnnotationHandler,
		"workspace.getAnnotation": getAnnotationHandler,
		"workspace.listAnnotations": listAnnotationsHandler,
		"workspace.refreshAnnotation": refreshAnnotationHandler,
		"workspace.scrubAnnotation": scrubAnnotationHandler,
		"workspace.restoreAnnotation": restoreAnnotationHandler,
		"workspace.containAnnotation": containAnnotationHandler,
		"workspace.uncontainAnnotation": uncontainAnnotationHandler,
		"workspace.annotationTree": annotationTreeHandler,
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
			const annotationStores = Array.from(symbolAnnotations.values());
			symbolAnnotations.clear();
			for (const watcher of osWatchersByWorkspace.values()) watcher.close();
			osWatchersByWorkspace.clear();
			await Promise.all([warmIndexes.closeAll(), graphRefresh.close(), ...annotationStores.map((store) => store.close())]);
		},
		async reapIdleSymbolIndexes(maxIdleMs: number): Promise<number> {
			return warmIndexes.reapIdle(maxIdleMs);
		},
	};
}

export { JobCapacityExceeded, JobNotFound } from "./domain/bounded-job-executor.ts";
export type { ClosableSymbolIndex } from "./service/warm-index-registry.ts";
export { LineEditRace, LineEditRejected, PatchRejected, RelativeWorkspacePath, StaleExpectedHash, WatchLimitExceeded, WorkspaceEntryNotFound };
